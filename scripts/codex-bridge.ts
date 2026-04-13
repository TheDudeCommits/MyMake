import archiver from "archiver";
import AdmZip from "adm-zip";
import express from "express";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

const app = express();
const port = Number(process.env.MYMAKE_CODEX_BRIDGE_PORT || 8766);
const codexBin = process.env.MYMAKE_CODEX_BIN || "codex";
const bridgeRoot = path.join(os.homedir(), ".mymake-codex-bridge");
const projectsRoot = path.join(bridgeRoot, "projects");
const statePath = path.join(bridgeRoot, "state.json");

type BridgeProjectState = {
  projectId: string;
  userId: string | null;
  projectName: string;
  threadId: string | null;
  lastSyncedRevisionId: string | null;
  updatedAt: string;
};

type BridgeState = {
  projects: Record<string, BridgeProjectState>;
};

type BridgeEditRequest = {
  prompt: string;
  projectName?: string;
  userId?: string | null;
  currentRoute?: string | null;
  selection?: {
    route?: string;
    tagName?: string;
    textContent?: string;
    selector?: string | null;
    scopedSelector?: string | null;
    nearestFramerName?: string | null;
    editableProperties?: string[];
    outerHtml?: string;
  } | null;
  previousFailures?: string[];
};

function stateKey(projectId: string, userId?: string | null): string {
  return `${userId || "anonymous"}:${projectId}`;
}

function workspaceDirFor(projectId: string, userId?: string | null): string {
  const slug = stateKey(projectId, userId).replace(/[^a-zA-Z0-9:_-]+/g, "_");
  return path.join(projectsRoot, slug, "workspace");
}

function projectDirFor(projectId: string, userId?: string | null): string {
  const slug = stateKey(projectId, userId).replace(/[^a-zA-Z0-9:_-]+/g, "_");
  return path.join(projectsRoot, slug);
}

function nowIso(): string {
  return new Date().toISOString();
}

async function ensureBridgeStorage(): Promise<void> {
  await fsp.mkdir(projectsRoot, { recursive: true });
}

async function loadState(): Promise<BridgeState> {
  try {
    const raw = await fsp.readFile(statePath, "utf8");
    const parsed = JSON.parse(raw) as BridgeState;
    return {
      projects: parsed.projects || {},
    };
  } catch {
    return { projects: {} };
  }
}

async function saveState(state: BridgeState): Promise<void> {
  await ensureBridgeStorage();
  await fsp.writeFile(statePath, JSON.stringify(state, null, 2), "utf8");
}

function allowOrigin(origin: string | undefined): boolean {
  if (!origin) {
    return true;
  }

  return (
    /^https:\/\/.+\.railway\.app$/.test(origin) ||
    /^http:\/\/localhost:\d+$/.test(origin) ||
    /^http:\/\/127\.0\.0\.1:\d+$/.test(origin)
  );
}

app.use((req, res, next) => {
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
  if (origin && !allowOrigin(origin)) {
    res.status(403).json({ error: "Origin is not allowed to connect to the local Codex bridge." });
    return;
  }

  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-MyMake-Project-Name, X-MyMake-Revision-Id, X-MyMake-User-Id");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS");
  res.setHeader("Access-Control-Allow-Private-Network", "true");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  next();
});

app.use(express.json({ limit: "2mb" }));

async function extractZipBufferToDirectory(buffer: Buffer, destination: string): Promise<void> {
  await fsp.rm(destination, { recursive: true, force: true });
  await fsp.mkdir(destination, { recursive: true });

  const archive = new AdmZip(buffer);
  for (const entry of archive.getEntries()) {
    const normalizedPath = path
      .normalize(entry.entryName)
      .replace(/^(\.\.(\/|\\|$))+/, "")
      .replace(/^[/\\]+/, "");

    if (!normalizedPath || normalizedPath.startsWith("..")) {
      continue;
    }

    const outputPath = path.join(destination, normalizedPath);
    if (entry.isDirectory) {
      await fsp.mkdir(outputPath, { recursive: true });
      continue;
    }

    await fsp.mkdir(path.dirname(outputPath), { recursive: true });
    await fsp.writeFile(outputPath, entry.getData());
  }
}

function shouldIgnoreExportPath(relativePath: string): boolean {
  return [
    /^node_modules(\/|$)/,
    /^\.next(\/|$)/,
    /^dist(\/|$)/,
    /^build(\/|$)/,
    /^coverage(\/|$)/,
    /^\.turbo(\/|$)/,
    /^__MACOSX(\/|$)/,
    /^\.DS_Store$/,
  ].some((pattern) => pattern.test(relativePath));
}

async function snapshotWorkspace(directory: string): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();

  async function walk(currentDir: string) {
    const entries = await fsp.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(currentDir, entry.name);
      const relativePath = path.relative(directory, absolutePath).split(path.sep).join("/");
      if (shouldIgnoreExportPath(relativePath)) {
        continue;
      }

      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }

      const buffer = await fsp.readFile(absolutePath);
      snapshot.set(relativePath, createHash("sha256").update(buffer).digest("hex"));
    }
  }

  await walk(directory);
  return snapshot;
}

function diffSnapshots(before: Map<string, string>, after: Map<string, string>): Array<{ path: string; reason?: string }> {
  const changed = new Set<string>();

  for (const [filePath, hash] of after.entries()) {
    if (before.get(filePath) !== hash) {
      changed.add(filePath);
    }
  }

  for (const filePath of before.keys()) {
    if (!after.has(filePath)) {
      changed.add(filePath);
    }
  }

  return Array.from(changed)
    .sort((left, right) => left.localeCompare(right))
    .map((filePath) => ({ path: filePath }));
}

async function runCodexTurn(params: {
  workspaceDir: string;
  prompt: string;
  threadId: string | null;
}): Promise<{ threadId: string; summary: string; rawOutput: string[] }> {
  const sharedArgs = [
    "--json",
    "--skip-git-repo-check",
    "-c",
    'approval_policy="never"',
    "-c",
    'sandbox_mode="workspace-write"',
  ];
  const args = params.threadId
    ? ["exec", "resume", ...sharedArgs, params.threadId, params.prompt]
    : ["exec", ...sharedArgs, "-C", params.workspaceDir, params.prompt];

  return new Promise((resolve, reject) => {
    const child = spawn(codexBin, args, {
      cwd: params.workspaceDir,
      env: process.env,
    });
    child.stdin.end();

    let threadId = params.threadId;
    let stdoutBuffer = "";
    let stderrBuffer = "";
    const rawOutput: string[] = [];
    let lastAgentMessage = "";

    const parseJsonl = (chunk: string) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) {
          continue;
        }

        rawOutput.push(trimmed);

        try {
          const event = JSON.parse(trimmed) as Record<string, unknown>;
          if (event.type === "thread.started" && typeof event.thread_id === "string") {
            threadId = event.thread_id;
          }

          if (
            event.type === "item.completed" &&
            event.item &&
            typeof event.item === "object" &&
            "type" in event.item &&
            "text" in event.item &&
            event.item.type === "agent_message" &&
            typeof event.item.text === "string"
          ) {
            lastAgentMessage = event.item.text.trim();
          }
        } catch {
          // Ignore non-JSONL log lines.
        }
      }
    };

    child.stdout.on("data", (data) => parseJsonl(data.toString()));
    child.stderr.on("data", (data) => {
      stderrBuffer += data.toString();
    });
    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            stderrBuffer.trim() || `Codex exited with code ${String(code)}.`,
          ),
        );
        return;
      }

      if (!threadId) {
        reject(new Error("Codex completed without returning a thread id."));
        return;
      }

      resolve({
        threadId,
        summary: lastAgentMessage || "Codex updated the workspace.",
        rawOutput,
      });
    });
  });
}

function buildCodexPrompt(request: BridgeEditRequest): string {
  const parts = [
    "You are the autonomous Codex worker for a MyMake project.",
    "Work directly in the local workspace files until the requested UI change is actually implemented.",
    "Do not stop at analysis. Inspect files, edit them, and make the project more likely to boot successfully after the change.",
    `User request: ${request.prompt.trim()}`,
  ];

  if (request.currentRoute) {
    parts.push(`Current route: ${request.currentRoute}`);
  }

  if (request.selection) {
    parts.push(
      [
        "Selected element context:",
        `- route: ${request.selection.route || "/"}`,
        `- label: ${request.selection.nearestFramerName || request.selection.tagName || "unknown"}`,
        `- selector: ${request.selection.scopedSelector || request.selection.selector || "none"}`,
        `- text: ${request.selection.textContent || "none"}`,
        `- editable properties: ${(request.selection.editableProperties || []).join(", ") || "unknown"}`,
        request.selection.outerHtml ? `- outer html excerpt: ${request.selection.outerHtml.slice(0, 1600)}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  if (request.previousFailures?.length) {
    parts.push(
      `Previous MyMake validation failures:\n${request.previousFailures
        .map((failure, index) => `${index + 1}. ${failure}`)
        .join("\n")}`,
    );
    parts.push(
      "Fix the root cause behind those failures before finishing. If the previous attempt did not visibly apply, choose a deeper edit path and make the change concrete in files.",
    );
  }

  parts.push(
    "When you finish, respond with a concise summary of the concrete changes you made. Do not include markdown fences.",
  );

  return parts.join("\n\n");
}

async function streamWorkspaceZip(sourceDir: string, res: express.Response): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("error", reject);
    res.on("close", () => resolve());

    archive.pipe(res);
    archive.glob("**/*", {
      cwd: sourceDir,
      dot: true,
      ignore: [
        "node_modules/**",
        ".next/**",
        "__MACOSX/**",
        ".DS_Store",
        "dist/**",
        "build/**",
        ".turbo/**",
        "coverage/**",
      ],
    });
    archive.finalize().catch(reject);
  });
}

app.get("/health", async (_req, res) => {
  res.json({
    ok: true,
    codexBin,
    bridgeRoot,
  });
});

app.get("/v1/projects/:projectId/state", async (req, res) => {
  const userId = typeof req.query.userId === "string" ? req.query.userId : null;
  const key = stateKey(req.params.projectId, userId);
  const state = await loadState();
  res.json({
    projectId: req.params.projectId,
    userId,
    state: state.projects[key] || null,
  });
});

app.put(
  "/v1/projects/:projectId/workspace",
  express.raw({ type: "application/zip", limit: "250mb" }),
  async (req, res) => {
    const userId =
      typeof req.headers["x-mymake-user-id"] === "string"
        ? req.headers["x-mymake-user-id"]
        : null;
    const projectName =
      typeof req.headers["x-mymake-project-name"] === "string"
        ? req.headers["x-mymake-project-name"]
        : req.params.projectId;
    const revisionId =
      typeof req.headers["x-mymake-revision-id"] === "string"
        ? req.headers["x-mymake-revision-id"]
        : null;

    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || []);
    if (!body.length) {
      res.status(400).json({ error: "MyMake did not send a project zip to the local bridge." });
      return;
    }

    const state = await loadState();
    const key = stateKey(req.params.projectId, userId);
    const projectDir = projectDirFor(req.params.projectId, userId);
    const workspaceDir = workspaceDirFor(req.params.projectId, userId);
    await fsp.mkdir(projectDir, { recursive: true });
    await extractZipBufferToDirectory(body, workspaceDir);

    state.projects[key] = {
      projectId: req.params.projectId,
      userId,
      projectName,
      threadId: state.projects[key]?.threadId || null,
      lastSyncedRevisionId: revisionId,
      updatedAt: nowIso(),
    };
    await saveState(state);

    res.json({
      ok: true,
      projectId: req.params.projectId,
      threadId: state.projects[key].threadId,
      lastSyncedRevisionId: revisionId,
    });
  },
);

app.post("/v1/projects/:projectId/edit", async (req, res) => {
  const request = req.body as BridgeEditRequest;
  const userId = request.userId || null;
  const key = stateKey(req.params.projectId, userId);
  const state = await loadState();
  const projectState = state.projects[key];

  if (!projectState) {
    res.status(400).json({
      error: "The local Codex bridge has not synced this project yet.",
    });
    return;
  }

  const workspaceDir = workspaceDirFor(req.params.projectId, userId);
  const before = await snapshotWorkspace(workspaceDir);
  const result = await runCodexTurn({
    workspaceDir,
    prompt: buildCodexPrompt(request),
    threadId: projectState.threadId,
  });
  const after = await snapshotWorkspace(workspaceDir);
  const changedFiles = diffSnapshots(before, after);

  state.projects[key] = {
    ...projectState,
    threadId: result.threadId,
    updatedAt: nowIso(),
  };
  await saveState(state);

  res.json({
    ok: true,
    projectId: req.params.projectId,
    threadId: result.threadId,
    summary: result.summary,
    changedFiles,
  });
});

app.get("/v1/projects/:projectId/export", async (req, res) => {
  const userId = typeof req.query.userId === "string" ? req.query.userId : null;
  const key = stateKey(req.params.projectId, userId);
  const state = await loadState();
  const projectState = state.projects[key];

  if (!projectState) {
    res.status(404).json({ error: "The local bridge does not have this project workspace yet." });
    return;
  }

  const workspaceDir = workspaceDirFor(req.params.projectId, userId);
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${req.params.projectId}.zip"`);
  await streamWorkspaceZip(workspaceDir, res);
});

ensureBridgeStorage()
  .then(() => {
    app.listen(port, () => {
      console.log(`MyMake Codex bridge listening on http://127.0.0.1:${port}`);
    });
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
