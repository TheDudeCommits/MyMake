import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import { nanoid } from "nanoid";

import {
  DEFAULT_AI_MODEL_KEY,
  listAiModels,
  requestAiEdit,
} from "@/lib/server/ai";
import type { ContextFile } from "@/lib/server/anthropic";
import { getDb } from "@/lib/server/db";
import { getEnv } from "@/lib/server/env";
import {
  buildFileTree,
  isTextLikeFile,
  listProjectFiles,
  resolveInsideRoot,
  toPosixPath,
} from "@/lib/server/path-utils";
import { ensurePreviewRunner, restartPreviewRunner } from "@/lib/server/preview-manager";
import {
  detectPackageManager,
  normalizeImportedProject,
  validateProjectDirectory,
} from "@/lib/server/project-validation";
import {
  archiveDirectoryToFile,
  createRevisionSnapshot,
  ensureProjectDirectories,
  ensureStorageReady,
  extractZipBufferToDirectory,
  getProjectPaths,
  syncSnapshotToCurrent,
} from "@/lib/server/storage";
import type {
  AiEditRequestPayload,
  AttachmentRecord,
  DashboardSnapshot,
  PackageManager,
  ProjectRecord,
  ProjectWorkspace,
  RevisionRecord,
} from "@/lib/types";

const CONFIG_RESTART_FILES = new Set([
  "next.config.js",
  "next.config.mjs",
  "next.config.ts",
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "postcss.config.js",
  "postcss.config.mjs",
  "postcss.config.ts",
  "tailwind.config.js",
  "tailwind.config.ts",
  "tsconfig.json",
  "vite.config.js",
  "vite.config.mjs",
  "vite.config.ts",
  "yarn.lock",
]);

function nowIso(): string {
  return new Date().toISOString();
}

function mapProjectRow(row: Record<string, unknown>): ProjectRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    sourceZipPath: String(row.source_zip_path),
    extractedPath: String(row.extracted_path),
    packageManager: row.package_manager as PackageManager,
    status: row.status as ProjectRecord["status"],
    currentRevisionId: row.current_revision_id ? String(row.current_revision_id) : null,
    manifestHash: row.manifest_hash ? String(row.manifest_hash) : null,
    previewPort: typeof row.preview_port === "number" ? row.preview_port : null,
    lastOpenedAt: String(row.last_opened_at),
    createdAt: String(row.created_at),
  };
}

function mapRevisionRow(row: Record<string, unknown>): RevisionRecord {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    parentRevisionId: row.parent_revision_id ? String(row.parent_revision_id) : null,
    label: String(row.label),
    source: row.source as RevisionRecord["source"],
    snapshotPath: String(row.snapshot_path),
    sequence: Number(row.sequence),
    summary: row.summary ? String(row.summary) : null,
    createdAt: String(row.created_at),
  };
}

function mapAttachmentRow(row: Record<string, unknown>): AttachmentRecord {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    filename: String(row.filename),
    mimeType: String(row.mime_type),
    storagePath: String(row.storage_path),
    sizeBytes: Number(row.size_bytes),
    createdAt: String(row.created_at),
  };
}

function getProjectRow(projectId: string): ProjectRecord {
  const row = getDb()
    .prepare("SELECT * FROM projects WHERE id = ?")
    .get(projectId) as Record<string, unknown> | undefined;

  if (!row) {
    throw new Error("Project not found.");
  }

  return mapProjectRow(row);
}

function getRevisionRows(projectId: string): RevisionRecord[] {
  const rows = getDb()
    .prepare(
      `SELECT *
         FROM revisions
        WHERE project_id = ?
        ORDER BY sequence DESC`,
    )
    .all(projectId) as Record<string, unknown>[];
  return rows.map(mapRevisionRow);
}

function getRevisionById(revisionId: string): RevisionRecord {
  const row = getDb()
    .prepare("SELECT * FROM revisions WHERE id = ?")
    .get(revisionId) as Record<string, unknown> | undefined;

  if (!row) {
    throw new Error("Revision not found.");
  }

  return mapRevisionRow(row);
}

function getAttachmentRows(projectId: string): AttachmentRecord[] {
  const rows = getDb()
    .prepare(
      `SELECT *
         FROM attachments
        WHERE project_id = ?
        ORDER BY created_at DESC`,
    )
    .all(projectId) as Record<string, unknown>[];
  return rows.map(mapAttachmentRow);
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readManifestHash(projectDir: string): Promise<string> {
  const hash = createHash("sha1");
  const manifestFiles = ["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"];

  for (const fileName of manifestFiles) {
    const filePath = path.join(projectDir, fileName);
    if (!(await pathExists(filePath))) {
      continue;
    }

    hash.update(fileName);
    hash.update(await fs.readFile(filePath));
  }

  return hash.digest("hex");
}

async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  label: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";

    child.stdout.on("data", (chunk) => {
      process.stdout.write(`[${label}] ${chunk}`);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      process.stderr.write(`[${label}] ${chunk}`);
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${label} failed with code ${code}: ${stderr}`));
    });
  });
}

function installEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_ENV: "development",
    npm_config_production: "false",
    NPM_CONFIG_PRODUCTION: "false",
    YARN_PRODUCTION: "false",
  };
}

async function installDependencies(projectDir: string, packageManager: PackageManager): Promise<void> {
  const env = installEnvironment();

  if (packageManager === "pnpm") {
    await runCommand("pnpm", ["install", "--prod=false"], projectDir, "pnpm install", env);
    return;
  }

  if (packageManager === "yarn") {
    await runCommand(
      "yarn",
      ["install", "--production=false"],
      projectDir,
      "yarn install",
      env,
    );
    return;
  }

  await runCommand("npm", ["install", "--include=dev"], projectDir, "npm install", env);
}

function defaultFileCandidates(files: string[]): string[] {
  const priorities = [
    "app/page.tsx",
    "app/page.jsx",
    "pages/index.tsx",
    "pages/index.jsx",
    "app/layout.tsx",
    "app/globals.css",
    "src/app/App.tsx",
    "src/app/App.jsx",
    "src/App.tsx",
    "src/App.jsx",
    "src/main.tsx",
    "src/main.jsx",
    "src/styles/theme.css",
    "src/styles/index.css",
    "index.html",
  ];

  const chosen = priorities.filter((candidate) => files.includes(candidate));
  if (chosen.length) {
    return chosen;
  }

  return files.filter((file) => file.endsWith(".tsx") || file.endsWith(".ts") || file.endsWith(".css"));
}

async function readFileIfText(projectDir: string, relativePath: string): Promise<string | null> {
  const absolutePath = resolveInsideRoot(projectDir, relativePath);
  if (!isTextLikeFile(absolutePath)) {
    return null;
  }

  return fs.readFile(absolutePath, "utf8");
}

function getRouteCandidates(route: string): string[] {
  const normalizedRoute = route === "/" ? "" : route.replace(/^\/+|\/+$/g, "");
  const parts = normalizedRoute ? normalizedRoute.split("/") : [];
  const candidates = [
    "app/layout.tsx",
    "app/globals.css",
    "pages/_app.tsx",
    "src/app/App.tsx",
    "src/app/App.jsx",
    "src/App.tsx",
    "src/App.jsx",
    "src/main.tsx",
    "src/main.jsx",
    "src/routes.ts",
    "src/routes.tsx",
    "src/styles/theme.css",
    "src/styles/index.css",
    "src/styles/tailwind.css",
    "index.html",
  ];

  if (!parts.length) {
    candidates.push("app/page.tsx", "pages/index.tsx");
    return candidates;
  }

  const joined = parts.join("/");
  candidates.push(
    `app/${joined}/page.tsx`,
    `app/${joined}/layout.tsx`,
    `pages/${joined}.tsx`,
    `pages/${joined}/index.tsx`,
  );

  return candidates;
}

async function collectContextFiles(
  projectDir: string,
  route: string,
  currentFilePath: string | null | undefined,
  prompt: string,
): Promise<ContextFile[]> {
  const allFiles = (await listProjectFiles(projectDir)).filter((file) =>
    isTextLikeFile(path.join(projectDir, file)),
  );
  const routeCandidates = new Set(getRouteCandidates(route));
  const promptTerms = prompt
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((term) => term.length > 3);

  const scored = allFiles
    .map((file) => {
      let score = 0;
      if (routeCandidates.has(file)) {
        score += 100;
      }

      if (currentFilePath && file === currentFilePath) {
        score += 90;
      }

      if (file.startsWith("components/") || file.includes("/components/")) {
        score += 15;
      }

      for (const term of promptTerms) {
        if (file.toLowerCase().includes(term)) {
          score += 8;
        }
      }

      return { file, score };
    })
    .sort((left, right) => right.score - left.score || left.file.localeCompare(right.file));

  const contextFiles: ContextFile[] = [];
  let currentSize = 0;

  for (const item of scored) {
    if (contextFiles.length >= 14) {
      break;
    }

    const content = await readFileIfText(projectDir, item.file);
    if (!content) {
      continue;
    }

    currentSize += content.length;
    if (currentSize > 90_000) {
      break;
    }

    contextFiles.push({
      path: item.file,
      content,
      reason:
        routeCandidates.has(item.file)
          ? "current route"
          : currentFilePath === item.file
            ? "active code editor file"
            : "supporting source file",
    });
  }

  return contextFiles;
}

async function trimOldRevisions(projectId: string): Promise<void> {
  const revisions = getRevisionRows(projectId).reverse();
  if (revisions.length <= getEnv().maxRevisionCount) {
    return;
  }

  const excess = revisions.slice(0, revisions.length - getEnv().maxRevisionCount);
  for (const revision of excess) {
    await fs.rm(revision.snapshotPath, { recursive: true, force: true });
    getDb().prepare("DELETE FROM revisions WHERE id = ?").run(revision.id);
  }
}

async function pruneRedoBranch(projectId: string): Promise<void> {
  const project = getProjectRow(projectId);
  if (!project.currentRevisionId) {
    return;
  }

  const currentRevision = getRevisionById(project.currentRevisionId);
  const futureRevisions = getDb()
    .prepare(
      `SELECT id, snapshot_path
         FROM revisions
        WHERE project_id = ?
          AND sequence > ?`,
    )
    .all(projectId, currentRevision.sequence) as { id: string; snapshot_path: string }[];

  for (const revision of futureRevisions) {
    await fs.rm(revision.snapshot_path, { recursive: true, force: true });
    getDb().prepare("DELETE FROM revisions WHERE id = ?").run(revision.id);
  }
}

async function createRevision(params: {
  projectId: string;
  label: string;
  source: RevisionRecord["source"];
  summary?: string | null;
}): Promise<RevisionRecord> {
  const project = getProjectRow(params.projectId);
  const currentRevision = project.currentRevisionId
    ? getRevisionById(project.currentRevisionId)
    : null;
  const nextSequence =
    (getDb()
      .prepare("SELECT COALESCE(MAX(sequence), -1) AS sequence FROM revisions WHERE project_id = ?")
      .get(params.projectId) as { sequence: number }).sequence + 1;

  const revisionId = nanoid(10);
  const snapshotPath = await createRevisionSnapshot(params.projectId, revisionId);
  const revision: RevisionRecord = {
    id: revisionId,
    projectId: params.projectId,
    parentRevisionId: currentRevision?.id || null,
    label: params.label,
    source: params.source,
    snapshotPath,
    sequence: nextSequence,
    summary: params.summary || null,
    createdAt: nowIso(),
  };

  getDb()
    .prepare(
      `INSERT INTO revisions (
        id, project_id, parent_revision_id, label, source, snapshot_path, sequence, summary, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      revision.id,
      revision.projectId,
      revision.parentRevisionId,
      revision.label,
      revision.source,
      revision.snapshotPath,
      revision.sequence,
      revision.summary,
      revision.createdAt,
    );

  const manifestHash = await readManifestHash(project.extractedPath);
  getDb()
    .prepare(
      `UPDATE projects
          SET current_revision_id = ?, manifest_hash = ?, last_opened_at = ?
        WHERE id = ?`,
    )
    .run(revision.id, manifestHash, nowIso(), params.projectId);

  await trimOldRevisions(params.projectId);
  return revision;
}

async function maybeRefreshPreview(projectId: string, changedPaths: string[]): Promise<void> {
  const shouldRestart = changedPaths.some((relativePath) =>
    CONFIG_RESTART_FILES.has(path.basename(relativePath)),
  );

  if (shouldRestart) {
    await restartPreviewRunner(projectId);
    return;
  }

  await ensurePreviewRunner(projectId);
}

export async function listProjects(): Promise<ProjectRecord[]> {
  await ensureStorageReady();
  const rows = getDb()
    .prepare(
      `SELECT *
         FROM projects
        ORDER BY last_opened_at DESC`,
    )
    .all() as Record<string, unknown>[];
  return rows.map(mapProjectRow);
}

export async function getWorkspaceSnapshot(
  projectId: string,
  options: {
    currentFilePath?: string | null;
    ensurePreview?: boolean;
  } = {},
): Promise<ProjectWorkspace> {
  let project = getProjectRow(projectId);
  let previewStatus: ProjectWorkspace["preview"]["status"] =
    project.status === "error" ? "error" : project.status === "ready" ? "ready" : "starting";

  if (options.ensurePreview) {
    try {
      await ensurePreviewRunner(projectId);
      previewStatus = "ready";
    } catch {
      getDb()
        .prepare(
          `UPDATE projects
              SET status = ?, last_opened_at = ?
            WHERE id = ?`,
        )
        .run("error", nowIso(), projectId);
      previewStatus = "error";
    }

    project = getProjectRow(projectId);
  }

  const files = await listProjectFiles(project.extractedPath);
  const currentFilePath =
    options.currentFilePath ||
    defaultFileCandidates(files).find(Boolean) ||
    files.find((file) => isTextLikeFile(path.join(project.extractedPath, file))) ||
    null;
  const currentFileContent =
    currentFilePath && isTextLikeFile(path.join(project.extractedPath, currentFilePath))
      ? await fs.readFile(path.join(project.extractedPath, currentFilePath), "utf8")
      : null;

  return {
    project: getProjectRow(projectId),
    revisions: getRevisionRows(projectId),
    attachments: getAttachmentRows(projectId),
    fileTree: await buildFileTree(project.extractedPath),
    currentFilePath,
    currentFileContent,
    preview: {
      url: `/preview/${projectId}`,
      status: project.status === "error" ? "error" : previewStatus,
      port: project.previewPort,
    },
  };
}

export async function getDashboardSnapshot(
  selectedProjectId?: string | null,
): Promise<DashboardSnapshot> {
  const projects = await listProjects();
  const currentProjectId = selectedProjectId || projects[0]?.id || null;

  return {
    projects,
    currentProjectId,
    currentProject: currentProjectId
      ? await getWorkspaceSnapshot(currentProjectId, { ensurePreview: false })
      : null,
    aiModels: listAiModels(),
    defaultAiModelKey: DEFAULT_AI_MODEL_KEY,
  };
}

export async function createProjectFromUpload(
  filename: string,
  zipBuffer: Buffer,
): Promise<ProjectWorkspace> {
  await ensureStorageReady();
  const projectId = nanoid(10);
  const timestamp = nowIso();
  const projectPaths = await ensureProjectDirectories(projectId);
  await fs.writeFile(projectPaths.sourceZip, zipBuffer);

  const unpackDir = path.join(projectPaths.root, "unpacked");
  await extractZipBufferToDirectory(zipBuffer, unpackDir);

  const validation = await validateProjectDirectory(unpackDir);
  if (!validation.ok) {
    await fs.rm(projectPaths.root, { recursive: true, force: true });
    throw new Error(validation.reason);
  }

  await fs.cp(unpackDir, projectPaths.current, { recursive: true, force: true });
  await normalizeImportedProject(projectPaths.current);

  const packageManager = await detectPackageManager(projectPaths.current);
  const insertedProject: ProjectRecord = {
    id: projectId,
    name: filename.replace(/\.zip$/i, ""),
    sourceZipPath: projectPaths.sourceZip,
    extractedPath: projectPaths.current,
    packageManager,
    status: "installing",
    currentRevisionId: null,
    manifestHash: null,
    previewPort: null,
    lastOpenedAt: timestamp,
    createdAt: timestamp,
  };

  getDb()
    .prepare(
      `INSERT INTO projects (
        id, name, source_zip_path, extracted_path, package_manager, status,
        current_revision_id, manifest_hash, preview_port, last_opened_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      insertedProject.id,
      insertedProject.name,
      insertedProject.sourceZipPath,
      insertedProject.extractedPath,
      insertedProject.packageManager,
      insertedProject.status,
      insertedProject.currentRevisionId,
      insertedProject.manifestHash,
      insertedProject.previewPort,
      insertedProject.lastOpenedAt,
      insertedProject.createdAt,
    );

  try {
    await installDependencies(projectPaths.current, packageManager);
    const manifestHash = await readManifestHash(projectPaths.current);
    getDb()
      .prepare("UPDATE projects SET status = ?, manifest_hash = ? WHERE id = ?")
      .run("ready", manifestHash, projectId);

    await createRevision({
      projectId,
      label: "Initial upload",
      source: "upload",
      summary: "Imported from uploaded zip archive.",
    });

    await ensurePreviewRunner(projectId);
    await fs.rm(unpackDir, { recursive: true, force: true });
    return getWorkspaceSnapshot(projectId, { ensurePreview: true });
  } catch (error) {
    getDb().prepare("UPDATE projects SET status = ? WHERE id = ?").run("error", projectId);
    throw error;
  }
}

export async function readProjectFile(projectId: string, relativePath: string) {
  const project = getProjectRow(projectId);
  const absolutePath = resolveInsideRoot(project.extractedPath, relativePath);
  if (!isTextLikeFile(absolutePath)) {
    throw new Error("This file cannot be opened in the code editor.");
  }

  return {
    path: toPosixPath(relativePath),
    content: await fs.readFile(absolutePath, "utf8"),
  };
}

export async function saveProjectFile(
  projectId: string,
  relativePath: string,
  content: string,
): Promise<ProjectWorkspace> {
  const project = getProjectRow(projectId);
  await pruneRedoBranch(projectId);

  const absolutePath = resolveInsideRoot(project.extractedPath, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, content, "utf8");

  const nextManifestHash = await readManifestHash(project.extractedPath);
  if (nextManifestHash !== project.manifestHash) {
    await installDependencies(project.extractedPath, project.packageManager);
  }

  await createRevision({
    projectId,
    label: `Saved ${path.basename(relativePath)}`,
    source: "manual",
    summary: `Updated ${relativePath}`,
  });

  await maybeRefreshPreview(projectId, [relativePath]);
  return getWorkspaceSnapshot(projectId, { currentFilePath: relativePath, ensurePreview: true });
}

export async function saveAttachments(
  projectId: string,
  files: Array<{ filename: string; mimeType: string; data: Buffer }>,
): Promise<AttachmentRecord[]> {
  const paths = await ensureProjectDirectories(projectId);
  const created: AttachmentRecord[] = [];

  for (const file of files) {
    const attachmentId = nanoid(10);
    const storagePath = path.join(paths.attachments, `${attachmentId}-${file.filename}`);
    await fs.writeFile(storagePath, file.data);

    const record: AttachmentRecord = {
      id: attachmentId,
      projectId,
      filename: file.filename,
      mimeType: file.mimeType,
      storagePath,
      sizeBytes: file.data.byteLength,
      createdAt: nowIso(),
    };

    getDb()
      .prepare(
        `INSERT INTO attachments (
          id, project_id, filename, mime_type, storage_path, size_bytes, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.projectId,
        record.filename,
        record.mimeType,
        record.storagePath,
        record.sizeBytes,
        record.createdAt,
      );

    created.push(record);
  }

  return created;
}

export async function applyAiEdit(
  payload: AiEditRequestPayload,
): Promise<{
  summary: string;
  warnings: string[];
  changedFiles: Array<{ path: string; reason?: string }>;
  workspace: ProjectWorkspace;
}> {
  const project = getProjectRow(payload.projectId);
  const currentRevision = project.currentRevisionId
    ? getRevisionById(project.currentRevisionId)
    : null;

  if (!currentRevision || currentRevision.id !== payload.revisionId) {
    throw new Error("The selected revision is out of date. Refresh and try again.");
  }

  await pruneRedoBranch(payload.projectId);

  const attachmentRows = payload.attachmentIds.length
    ? (getDb()
        .prepare(
          `SELECT *
             FROM attachments
            WHERE project_id = ?
              AND id IN (${payload.attachmentIds.map(() => "?").join(",")})`,
        )
        .all(payload.projectId, ...payload.attachmentIds) as Record<string, unknown>[])
    : [];

  const attachments = await Promise.all(
    attachmentRows.map(async (row) => {
      const mapped = mapAttachmentRow(row);
      return {
        id: mapped.id,
        filename: mapped.filename,
        mimeType: mapped.mimeType,
        data: await fs.readFile(mapped.storagePath),
      };
    }),
  );

  const route = payload.selection?.route || "/";
  const contextFiles = await collectContextFiles(
    project.extractedPath,
    route,
    payload.currentFilePath,
    payload.prompt,
  );

  const aiResult = await requestAiEdit({
    aiModelKey: payload.aiModelKey,
    prompt: payload.prompt,
    selection: payload.selection,
    contextFiles,
    attachments,
  });

  const changedPaths: string[] = [];
  for (const change of aiResult.changedFiles) {
    const absolutePath = resolveInsideRoot(project.extractedPath, change.path);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, change.content, "utf8");
    changedPaths.push(toPosixPath(change.path));
  }

  const nextManifestHash = await readManifestHash(project.extractedPath);
  if (nextManifestHash !== project.manifestHash) {
    await installDependencies(project.extractedPath, project.packageManager);
  }

  await createRevision({
    projectId: payload.projectId,
    label: payload.prompt.slice(0, 72),
    source: "ai",
    summary: aiResult.summary,
  });

  await maybeRefreshPreview(payload.projectId, changedPaths);
  return {
    summary: aiResult.summary,
    warnings: aiResult.warnings,
    changedFiles: aiResult.changedFiles.map((item) => ({
      path: item.path,
      reason: item.reason,
    })),
    workspace: await getWorkspaceSnapshot(payload.projectId, {
      currentFilePath: payload.currentFilePath || changedPaths[0] || null,
      ensurePreview: true,
    }),
  };
}

async function switchToRevision(
  projectId: string,
  targetRevision: RevisionRecord,
): Promise<ProjectWorkspace> {
  const project = getProjectRow(projectId);
  await syncSnapshotToCurrent(targetRevision.snapshotPath, project.extractedPath);

  const restoredManifestHash = await readManifestHash(project.extractedPath);
  if (restoredManifestHash !== project.manifestHash) {
    await installDependencies(project.extractedPath, project.packageManager);
  }

  getDb()
    .prepare(
      `UPDATE projects
          SET current_revision_id = ?, manifest_hash = ?, last_opened_at = ?
        WHERE id = ?`,
    )
    .run(targetRevision.id, restoredManifestHash, nowIso(), projectId);

  await restartPreviewRunner(projectId);
  return getWorkspaceSnapshot(projectId, { ensurePreview: true });
}

export async function undoProject(projectId: string): Promise<ProjectWorkspace> {
  const project = getProjectRow(projectId);
  if (!project.currentRevisionId) {
    return getWorkspaceSnapshot(projectId, { ensurePreview: true });
  }

  const currentRevision = getRevisionById(project.currentRevisionId);
  const previousRow = getDb()
    .prepare(
      `SELECT *
         FROM revisions
        WHERE project_id = ?
          AND sequence < ?
        ORDER BY sequence DESC
        LIMIT 1`,
    )
    .get(projectId, currentRevision.sequence) as Record<string, unknown> | undefined;

  if (!previousRow) {
    return getWorkspaceSnapshot(projectId, { ensurePreview: true });
  }

  return switchToRevision(projectId, mapRevisionRow(previousRow));
}

export async function redoProject(projectId: string): Promise<ProjectWorkspace> {
  const project = getProjectRow(projectId);
  if (!project.currentRevisionId) {
    return getWorkspaceSnapshot(projectId, { ensurePreview: true });
  }

  const currentRevision = getRevisionById(project.currentRevisionId);
  const nextRow = getDb()
    .prepare(
      `SELECT *
         FROM revisions
        WHERE project_id = ?
          AND sequence > ?
        ORDER BY sequence ASC
        LIMIT 1`,
    )
    .get(projectId, currentRevision.sequence) as Record<string, unknown> | undefined;

  if (!nextRow) {
    return getWorkspaceSnapshot(projectId, { ensurePreview: true });
  }

  return switchToRevision(projectId, mapRevisionRow(nextRow));
}

export async function createProjectExport(projectId: string): Promise<string> {
  const project = getProjectRow(projectId);
  const outputPath = path.join(getProjectPaths(projectId).root, `export-${Date.now()}.zip`);
  await archiveDirectoryToFile(project.extractedPath, outputPath);
  return outputPath;
}
