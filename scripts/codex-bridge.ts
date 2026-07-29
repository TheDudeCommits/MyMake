import archiver from "archiver";
import AdmZip from "adm-zip";
import express from "express";
import { constants as fsConstants, existsSync } from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const app = express();
const port = Number(process.env.MYMAKE_CODEX_BRIDGE_PORT || 8766);
const editRateLimitWindowMs = 60_000;
const editRateLimitMaxRequests = 12;
const editRateBuckets = new Map<string, { count: number; resetAt: number }>();
const bundledCodexBin = "/Applications/Codex.app/Contents/Resources/codex";
const trustedCodexBins = [
  bundledCodexBin,
  "/opt/homebrew/bin/codex",
  "/usr/local/bin/codex",
  "/usr/bin/codex",
] as const;

function resolveTrustedCodexBin(): string {
  const candidate = trustedCodexBins.find((entry) => existsSync(entry));
  if (!candidate) {
    throw new Error(
      "MyMake could not find Codex in a trusted installation location. Install Codex.app or the Codex CLI in /opt/homebrew/bin or /usr/local/bin.",
    );
  }
  return candidate;
}

const codexBin = resolveTrustedCodexBin();
const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), "..");

function resolveInsideRoot(root: string, relativePath: string): string {
  if (
    /[\u0000-\u001f\u007f]/.test(relativePath) ||
    path.isAbsolute(relativePath) ||
    /^[\\/]/.test(relativePath) ||
    /^[A-Za-z]:[\\/]/.test(relativePath)
  ) {
    throw new Error("Path must be a safe relative path.");
  }
  if (relativePath.split(/[\\/]+/).includes("..")) {
    throw new Error("Path traversal segments are not allowed.");
  }

  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath.replace(/[\\/]/g, path.sep));
  const containmentPath = path.relative(resolvedRoot, resolved);
  if (
    containmentPath === ".." ||
    containmentPath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(containmentPath)
  ) {
    throw new Error("Path escapes the bridge root.");
  }
  return resolved;
}

const bridgeRoot = resolveInsideRoot(path.resolve(os.homedir()), ".mymake-codex-bridge");
const projectsRoot = resolveInsideRoot(bridgeRoot, "projects");
const statePath = resolveInsideRoot(bridgeRoot, "state.json");
const configPath = resolveInsideRoot(bridgeRoot, "config.json");
const launchAgentsDir = resolveInsideRoot(path.resolve(os.homedir()), "Library/LaunchAgents");
const launchAgentLabel = "com.mymake.codex-bridge";
const launchAgentPath = resolveInsideRoot(launchAgentsDir, `${launchAgentLabel}.plist`);
const bridgeStdoutLogPath = resolveInsideRoot(bridgeRoot, "codex-bridge.log");
const bridgeStderrLogPath = resolveInsideRoot(bridgeRoot, "codex-bridge.error.log");

type BridgeStartMode = "always-on" | "codex-app";

type BridgeConfig = {
  mode: BridgeStartMode;
  autoStart: boolean;
  updatedAt: string;
};

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

type BridgeSettingsRequest = {
  mode?: BridgeStartMode;
  autoStart?: boolean;
};

type BridgeOpenSessionRequest = {
  userId?: string | null;
  projectName?: string;
};

function enforceEditRateLimit(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  const now = Date.now();
  const key = req.ip || req.socket.remoteAddress || "local";
  const current = editRateBuckets.get(key);
  const bucket =
    !current || current.resetAt <= now
      ? { count: 0, resetAt: now + editRateLimitWindowMs }
      : current;

  if (bucket.count >= editRateLimitMaxRequests) {
    res.setHeader("Retry-After", String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
    res.status(429).json({ error: "Too many edit requests. Try again in a moment." });
    return;
  }

  bucket.count += 1;
  editRateBuckets.set(key, bucket);
  if (editRateBuckets.size > 1000) {
    for (const [bucketKey, value] of editRateBuckets) {
      if (value.resetAt <= now) {
        editRateBuckets.delete(bucketKey);
      }
    }
  }
  next();
}

function stateKey(projectId: string, userId?: string | null): string {
  return `${userId || "anonymous"}:${projectId}`;
}

function workspaceDirFor(projectId: string, userId?: string | null): string {
  return resolveInsideRoot(projectDirFor(projectId, userId), "workspace");
}

function projectDirFor(projectId: string, userId?: string | null): string {
  const slug = createHash("sha256").update(stateKey(projectId, userId)).digest("hex").slice(0, 32);
  return resolveInsideRoot(projectsRoot, slug);
}

function nowIso(): string {
  return new Date().toISOString();
}

function defaultBridgeConfig(): BridgeConfig {
  return {
    mode: "always-on",
    autoStart: false,
    updatedAt: nowIso(),
  };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function ensureBridgeStorage(): Promise<void> {
  await fsp.mkdir(projectsRoot, { recursive: true });
  await fsp.mkdir(launchAgentsDir, { recursive: true });
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

async function loadConfig(): Promise<BridgeConfig> {
  try {
    const raw = await fsp.readFile(configPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<BridgeConfig>;
    const defaults = defaultBridgeConfig();
    return {
      mode: parsed.mode === "codex-app" ? "codex-app" : defaults.mode,
      autoStart: typeof parsed.autoStart === "boolean" ? parsed.autoStart : defaults.autoStart,
      updatedAt:
        typeof parsed.updatedAt === "string" && parsed.updatedAt.trim()
          ? parsed.updatedAt
          : defaults.updatedAt,
    };
  } catch {
    return defaultBridgeConfig();
  }
}

async function saveConfig(config: BridgeConfig): Promise<void> {
  await ensureBridgeStorage();
  await fsp.writeFile(configPath, JSON.stringify(config, null, 2), "utf8");
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
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, X-MyMake-Project-Name, X-MyMake-Revision-Id, X-MyMake-User-Id",
  );
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
    if (!entry.entryName || entry.entryName.includes("\u0000")) {
      continue;
    }

    const outputPath = resolveInsideRoot(destination, entry.entryName);
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
      if (entry.isSymbolicLink()) {
        continue;
      }
      const relativePath = path
        .join(path.relative(directory, currentDir), entry.name)
        .split(path.sep)
        .join("/");
      if (shouldIgnoreExportPath(relativePath)) {
        continue;
      }
      const absolutePath = resolveInsideRoot(directory, relativePath);

      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }

      const handle = await fsp.open(
        absolutePath,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
      );
      let buffer: Buffer;
      try {
        const stats = await handle.stat();
        if (!stats.isFile()) {
          continue;
        }
        buffer = await handle.readFile();
      } finally {
        await handle.close();
      }
      snapshot.set(relativePath, createHash("sha256").update(buffer).digest("hex"));
    }
  }

  await walk(directory);
  return snapshot;
}

function diffSnapshots(
  before: Map<string, string>,
  after: Map<string, string>,
): Array<{ path: string; reason?: string }> {
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

async function runCommand(
  command: string,
  args: string[],
  options?: {
    cwd?: string;
    allowFailure?: boolean;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  },
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options?.cwd,
      env: options?.env || process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeout: NodeJS.Timeout | null = null;

    if (options?.timeoutMs) {
      timeout = setTimeout(() => {
        child.kill("SIGTERM");
      }, options.timeoutMs);
    }

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });
    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }

      if (!options?.allowFailure && code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `${command} exited with ${String(code)}.`));
        return;
      }

      resolve({ stdout, stderr, code });
    });
  });
}

async function isCodexAppRunning(): Promise<boolean> {
  try {
    const result = await runCommand(
      "osascript",
      ["-e", 'tell application "System Events" to (name of processes) contains "Codex"'],
      { allowFailure: true, timeoutMs: 4000 },
    );
    return result.stdout.trim().toLowerCase() === "true";
  } catch {
    try {
      const result = await runCommand("pgrep", ["-x", "Codex"], {
        allowFailure: true,
        timeoutMs: 4000,
      });
      return result.code === 0;
    } catch {
      return false;
    }
  }
}

async function openCodexDesktopApp(): Promise<void> {
  await runCommand("open", ["-a", "Codex"], { timeoutMs: 5000 });
}

async function waitForCodexAppReady(timeoutMs = 12000): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await isCodexAppRunning()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return false;
}

async function ensureCodexAvailabilityForMode(config: BridgeConfig): Promise<void> {
  if (config.mode !== "codex-app") {
    return;
  }

  if (await isCodexAppRunning()) {
    return;
  }

  await openCodexDesktopApp();
  const ready = await waitForCodexAppReady();
  if (!ready) {
    throw new Error("Open Codex.app on this Mac so MyMake can use the local Codex session mode.");
  }
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

async function resolveTsxCliPath(): Promise<string> {
  const candidates = [
    resolveInsideRoot(projectRoot, "node_modules/tsx/dist/cli.mjs"),
    resolveInsideRoot(projectRoot, "node_modules/.bin/tsx"),
  ];

  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }

  throw new Error("MyMake could not find the local tsx runtime needed to install the bridge agent.");
}

function buildLaunchAgentPlist(tsxCliPath: string): string {
  const envEntries = {
    PATH: process.env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin",
    MYMAKE_CODEX_BRIDGE_PORT: String(port),
  };

  const programArguments = [process.execPath, tsxCliPath, scriptPath]
    .map((value) => `    <string>${xmlEscape(value)}</string>`)
    .join("\n");
  const environmentVariables = Object.entries(envEntries)
    .map(
      ([key, value]) =>
        `      <key>${xmlEscape(key)}</key>\n      <string>${xmlEscape(value)}</string>`,
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${xmlEscape(launchAgentLabel)}</string>
    <key>ProgramArguments</key>
    <array>
${programArguments}
    </array>
    <key>WorkingDirectory</key>
    <string>${xmlEscape(projectRoot)}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${xmlEscape(bridgeStdoutLogPath)}</string>
    <key>StandardErrorPath</key>
    <string>${xmlEscape(bridgeStderrLogPath)}</string>
    <key>EnvironmentVariables</key>
    <dict>
${environmentVariables}
    </dict>
  </dict>
</plist>
`;
}

async function getLaunchAgentStatus(): Promise<{
  installed: boolean;
  loaded: boolean;
  path: string;
}> {
  const installed = await fileExists(launchAgentPath);
  if (!installed) {
    return {
      installed: false,
      loaded: false,
      path: launchAgentPath,
    };
  }

  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  let loaded = false;
  if (uid !== null) {
    const result = await runCommand(
      "launchctl",
      ["print", `gui/${uid}/${launchAgentLabel}`],
      {
        allowFailure: true,
        timeoutMs: 5000,
      },
    );
    loaded = result.code === 0;
  }

  return {
    installed,
    loaded,
    path: launchAgentPath,
  };
}

async function installLaunchAgent(): Promise<void> {
  await ensureBridgeStorage();
  const tsxCliPath = await resolveTsxCliPath();
  const plist = buildLaunchAgentPlist(tsxCliPath);
  await fsp.writeFile(launchAgentPath, plist, "utf8");

  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid === null) {
    return;
  }

  await runCommand("launchctl", ["bootout", `gui/${uid}`, launchAgentPath], {
    allowFailure: true,
    timeoutMs: 5000,
  });

  const bootstrap = await runCommand(
    "launchctl",
    ["bootstrap", `gui/${uid}`, launchAgentPath],
    {
      allowFailure: true,
      timeoutMs: 8000,
    },
  );
  if (bootstrap.code !== 0) {
    await runCommand("launchctl", ["load", "-w", launchAgentPath], { timeoutMs: 8000 });
  }

  await runCommand("launchctl", ["kickstart", "-k", `gui/${uid}/${launchAgentLabel}`], {
    allowFailure: true,
    timeoutMs: 5000,
  });
}

async function uninstallLaunchAgent(): Promise<void> {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid !== null) {
    await runCommand("launchctl", ["bootout", `gui/${uid}`, launchAgentPath], {
      allowFailure: true,
      timeoutMs: 5000,
    });
    await runCommand("launchctl", ["unload", "-w", launchAgentPath], {
      allowFailure: true,
      timeoutMs: 5000,
    });
  }

  await fsp.rm(launchAgentPath, { force: true });
}

async function normalizeAndApplyConfig(request: BridgeSettingsRequest): Promise<BridgeConfig> {
  const current = await loadConfig();
  const next: BridgeConfig = {
    mode: request.mode === "codex-app" ? "codex-app" : request.mode === "always-on" ? "always-on" : current.mode,
    autoStart:
      typeof request.autoStart === "boolean" ? request.autoStart : current.autoStart,
    updatedAt: nowIso(),
  };

  await saveConfig(next);
  if (next.autoStart) {
    await installLaunchAgent();
  } else {
    await uninstallLaunchAgent();
  }

  return next;
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

async function openSessionInTerminal(params: {
  workspaceDir: string;
  threadId: string | null;
}): Promise<{ resumed: boolean; command: string }> {
  await openCodexDesktopApp().catch(() => undefined);

  const command = params.threadId
    ? `cd ${shellEscape(params.workspaceDir)} && ${shellEscape(codexBin)} resume --all --skip-git-repo-check ${shellEscape(params.threadId)}`
    : `cd ${shellEscape(params.workspaceDir)} && ${shellEscape(codexBin)} --skip-git-repo-check`;

  await runCommand(
    "osascript",
    [
      "-e",
      'tell application "Terminal" to activate',
      "-e",
      `tell application "Terminal" to do script ${appleScriptString(command)}`,
    ],
    { timeoutMs: 8000 },
  );

  return {
    resumed: Boolean(params.threadId),
    command,
  };
}

async function buildHealthPayload() {
  const config = await loadConfig();
  const launchAgent = await getLaunchAgentStatus();
  const codexAppRunning = await isCodexAppRunning();

  return {
    ok: true as const,
    codexBin,
    bridgeRoot,
    config,
    launchAgentInstalled: launchAgent.installed,
    launchAgentLoaded: launchAgent.loaded,
    launchAgentPath: launchAgent.path,
    codexAppRunning,
  };
}

async function runCodexTurn(params: {
  workspaceDir: string;
  prompt: string;
  threadId: string | null;
}): Promise<{ threadId: string; summary: string; rawOutput: string[] }> {
  const config = await loadConfig();
  await ensureCodexAvailabilityForMode(config);

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
        reject(new Error(stderrBuffer.trim() || `Codex exited with code ${String(code)}.`));
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
  res.json(await buildHealthPayload());
});

app.get("/v1/projects/:projectId/state", async (req, res) => {
  const userId = typeof req.query.userId === "string" ? req.query.userId : null;
  const key = stateKey(req.params.projectId, userId);
  const state = await loadState();
  res.json({
    projectId: req.params.projectId,
    userId,
    state: state.projects[key] || null,
    codexAppRunning: await isCodexAppRunning(),
  });
});

app.post("/v1/settings", async (req, res) => {
  try {
    const request = req.body as BridgeSettingsRequest;
    const config = await normalizeAndApplyConfig(request);
    res.json({
      ...(await buildHealthPayload()),
      config,
    });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "MyMake could not update the local Codex settings.",
    });
  }
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

app.post("/v1/projects/:projectId/edit", enforceEditRateLimit, async (req, res) => {
  const request = req.body as BridgeEditRequest;
  const projectId = String(req.params.projectId);
  const userId = request.userId || null;
  const key = stateKey(projectId, userId);
  const state = await loadState();
  const projectState = state.projects[key];

  if (!projectState) {
    res.status(400).json({
      error: "The local Codex bridge has not synced this project yet.",
    });
    return;
  }

  const workspaceDir = workspaceDirFor(projectId, userId);
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
    projectId,
    threadId: result.threadId,
    summary: result.summary,
    changedFiles,
  });
});

app.post("/v1/projects/:projectId/open-session", async (req, res) => {
  try {
    const request = req.body as BridgeOpenSessionRequest;
    const userId = request.userId || null;
    const key = stateKey(req.params.projectId, userId);
    const state = await loadState();
    const projectState = state.projects[key];

    if (!projectState) {
      res.status(400).json({
        error: "Sync this project into the local Codex bridge once before opening its session.",
      });
      return;
    }

    const config = await loadConfig();
    await ensureCodexAvailabilityForMode(config);
    const workspaceDir = workspaceDirFor(req.params.projectId, userId);
    const sessionResult = await openSessionInTerminal({
      workspaceDir,
      threadId: projectState.threadId,
    });

    res.json({
      ok: true,
      projectId: req.params.projectId,
      threadId: projectState.threadId,
      resumed: sessionResult.resumed,
      command: sessionResult.command,
    });
  } catch (error) {
    res.status(500).json({
      error:
        error instanceof Error
          ? error.message
          : "MyMake could not open the local Codex session for this project.",
    });
  }
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
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="project-${encodeURIComponent(req.params.projectId)}.zip"`,
  );
  await streamWorkspaceZip(workspaceDir, res);
});

ensureBridgeStorage()
  .then(() => {
    app.listen(port, "127.0.0.1", () => {
      console.log(`MyMake Codex bridge listening on http://127.0.0.1:${port}`);
    });
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
