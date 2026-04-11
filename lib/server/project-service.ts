import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import vm from "node:vm";

import { nanoid } from "nanoid";

import {
  DEFAULT_AI_MODEL_KEY,
  listAiModels,
  requestAiEdit,
  requestAiPatchEdit,
} from "@/lib/server/ai";
import { getDb } from "@/lib/server/db";
import { getEnv } from "@/lib/server/env";
import {
  buildDesignValidation,
  buildEditPlan,
  buildSelectionTarget,
  collectContextGraph,
  describeKitAssets,
  ensureProjectKnowledgeArtifacts,
  readKnowledgeFiles,
  updateEditMemory,
  type KnowledgeArtifacts,
} from "@/lib/server/project-intelligence";
import {
  buildFileTree,
  isTextLikeFile,
  listProjectFiles,
  resolveInsideRoot,
  toPosixPath,
} from "@/lib/server/path-utils";
import {
  ensurePreviewRunner,
  reclaimProjectInstallStorage,
  getPreviewRunnerInfo,
  restartPreviewRunner,
  stopPreviewRunner,
  warmPreviewRunner,
} from "@/lib/server/preview-manager";
import {
  detectProjectRuntime,
  detectPackageManager,
  normalizeImportedProject,
  runtimeRequiresDependencyInstall,
  validateProjectDirectory,
} from "@/lib/server/project-validation";
import {
  appendElementOverride,
  ensureStaticEditableOverridesSupport,
  getPreferredStaticEditableFile,
  hasStaticEditableOverrides,
  isEditableOverridesFile,
  normalizeOverrideConfigContent,
  OVERRIDES_CONFIG_PATH,
  OVERRIDES_CSS_PATH,
  OVERRIDES_README_PATH,
  OVERRIDES_SECTION_HOOKS_PATH,
  OVERRIDES_SECTION_NAMES_PATH,
} from "@/lib/server/static-overrides";
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
  ContextSnapshotRecord,
  ConversationTurnRecord,
  DashboardSnapshot,
  EditMode,
  EditPlan,
  MakeKitRecord,
  PackageManager,
  ProjectRecord,
  ProjectRuntime,
  ProjectWorkspace,
  RevisionRecord,
  SelectionPayload,
  SelectionTarget,
  ValidationResultRecord,
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

function requireRuntime(runtime: ProjectRuntime | null | undefined): ProjectRuntime {
  if (!runtime) {
    throw new Error("MyMake could not determine this project's runtime.");
  }

  return runtime;
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

function safeParseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || !value.trim()) {
    return fallback;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function mapContextSnapshotRow(row: Record<string, unknown>): ContextSnapshotRecord {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    revisionId: row.revision_id ? String(row.revision_id) : null,
    turnId: row.turn_id ? String(row.turn_id) : null,
    tokenBudget: Number(row.token_budget),
    primaryTarget: row.primary_target ? String(row.primary_target) : null,
    compressedMemory: row.compressed_memory ? String(row.compressed_memory) : null,
    sources: safeParseJson(row.sources_json, []),
    createdAt: String(row.created_at),
  };
}

function mapMakeKitRow(row: Record<string, unknown>): MakeKitRecord {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    name: String(row.name),
    kind: row.kind as MakeKitRecord["kind"],
    source: row.source as MakeKitRecord["source"],
    enabled: Boolean(row.enabled),
    priority: Number(row.priority),
    summary: String(row.summary),
    lockedRules: safeParseJson(row.locked_rules_json, []),
    softRules: safeParseJson(row.soft_rules_json, []),
    assets: safeParseJson(row.assets_json, []),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapValidationResultRow(row: Record<string, unknown>): ValidationResultRecord {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    revisionId: row.revision_id ? String(row.revision_id) : null,
    turnId: row.turn_id ? String(row.turn_id) : null,
    status: row.status as ValidationResultRecord["status"],
    buildStatus: row.build_status as ValidationResultRecord["buildStatus"],
    previewStatus: row.preview_status as ValidationResultRecord["previewStatus"],
    selectorStatus: row.selector_status as ValidationResultRecord["selectorStatus"],
    importsStatus: row.imports_status as ValidationResultRecord["importsStatus"],
    designStatus: row.design_status as ValidationResultRecord["designStatus"],
    warnings: safeParseJson(row.warnings_json, []),
    details: safeParseJson(row.details_json, []),
    rawProviderOutput: row.raw_provider_output ? String(row.raw_provider_output) : null,
    retryable: Boolean(row.retryable),
    createdAt: String(row.created_at),
  };
}

function mapConversationTurnRow(row: Record<string, unknown>): ConversationTurnRecord {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    revisionId: row.revision_id ? String(row.revision_id) : null,
    kind: row.kind as ConversationTurnRecord["kind"],
    status: row.status as ConversationTurnRecord["status"],
    prompt: row.prompt ? String(row.prompt) : null,
    summary: row.summary ? String(row.summary) : null,
    aiModelKey: row.ai_model_key ? (String(row.ai_model_key) as ConversationTurnRecord["aiModelKey"]) : null,
    provider: row.provider ? (String(row.provider) as ConversationTurnRecord["provider"]) : null,
    editMode: row.edit_mode ? (String(row.edit_mode) as EditMode) : null,
    selectionTarget: safeParseJson<SelectionTarget | null>(row.selection_target_json, null),
    changedFiles: safeParseJson(row.changed_files_json, []),
    warnings: safeParseJson(row.warnings_json, []),
    contextSnapshotId: row.context_snapshot_id ? String(row.context_snapshot_id) : null,
    validationResultId: row.validation_result_id ? String(row.validation_result_id) : null,
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

function getConversationTurns(projectId: string): ConversationTurnRecord[] {
  const rows = getDb()
    .prepare(
      `SELECT *
         FROM conversation_turns
        WHERE project_id = ?
        ORDER BY created_at ASC`,
    )
    .all(projectId) as Record<string, unknown>[];

  return rows.map(mapConversationTurnRow);
}

function getMakeKits(projectId: string): MakeKitRecord[] {
  const rows = getDb()
    .prepare(
      `SELECT *
         FROM make_kits
        WHERE project_id = ?
        ORDER BY priority DESC, updated_at DESC`,
    )
    .all(projectId) as Record<string, unknown>[];

  return rows.map(mapMakeKitRow);
}

function getLatestContextSnapshot(projectId: string): ContextSnapshotRecord | null {
  const row = getDb()
    .prepare(
      `SELECT *
         FROM context_snapshots
        WHERE project_id = ?
        ORDER BY created_at DESC
        LIMIT 1`,
    )
    .get(projectId) as Record<string, unknown> | undefined;

  return row ? mapContextSnapshotRow(row) : null;
}

function getLatestValidationResult(projectId: string): ValidationResultRecord | null {
  const row = getDb()
    .prepare(
      `SELECT *
         FROM validation_results
        WHERE project_id = ?
        ORDER BY created_at DESC
        LIMIT 1`,
    )
    .get(projectId) as Record<string, unknown> | undefined;

  return row ? mapValidationResultRow(row) : null;
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

function isNoSpaceError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /ENOSPC|no space left on device/i.test(message);
}

async function installDependenciesWithRecovery(
  projectId: string,
  projectDir: string,
  packageManager: PackageManager,
): Promise<void> {
  const runtime = await detectProjectRuntime(projectDir);
  if (!runtimeRequiresDependencyInstall(runtime)) {
    return;
  }

  try {
    await installDependencies(projectDir, packageManager);
  } catch (error) {
    if (!isNoSpaceError(error)) {
      throw error;
    }

    await fs.rm(path.join(projectDir, "node_modules"), { recursive: true, force: true });
    await fs.rm(path.join(projectDir, ".next"), { recursive: true, force: true });
    await reclaimProjectInstallStorage(projectId);
    await installDependencies(projectDir, packageManager);
  }
}

function defaultFileCandidates(files: string[]): string[] {
  const preferredStaticFile = getPreferredStaticEditableFile(files);
  if (preferredStaticFile) {
    return [
      preferredStaticFile,
      ...files.filter((file) =>
        [
          OVERRIDES_CSS_PATH,
          OVERRIDES_README_PATH,
          OVERRIDES_SECTION_HOOKS_PATH,
          OVERRIDES_SECTION_NAMES_PATH,
          "index.html",
        ].includes(file),
      ),
    ];
  }

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

function resolvePreferredAiFilePath(
  files: string[],
  requestedPath: string | null | undefined,
): string | null {
  if (requestedPath && files.includes(requestedPath) && isEditableOverridesFile(requestedPath)) {
    return requestedPath;
  }

  const preferredStaticFile = getPreferredStaticEditableFile(files);
  if (preferredStaticFile) {
    return preferredStaticFile;
  }

  if (requestedPath && files.includes(requestedPath)) {
    return requestedPath;
  }

  return defaultFileCandidates(files).find(Boolean) || null;
}

async function readFileIfText(projectDir: string, relativePath: string): Promise<string | null> {
  const absolutePath = resolveInsideRoot(projectDir, relativePath);
  if (!isTextLikeFile(absolutePath)) {
    return null;
  }

  return fs.readFile(absolutePath, "utf8");
}

const IMPORTABLE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".css",
  ".scss",
  ".sass",
  ".json",
];

function collectRelativeImports(content: string): string[] {
  const imports = new Set<string>();
  const patterns = [
    /(?:import|export)\s+(?:[^"'`]*?\sfrom\s*)?["'](\.{1,2}\/[^"'`]+)["']/g,
    /import\(\s*["'](\.{1,2}\/[^"'`]+)["']\s*\)/g,
  ];

  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      if (match[1]) {
        imports.add(match[1]);
      }
    }
  }

  return [...imports];
}

function importResolutionCandidates(baseFilePath: string, specifier: string): string[] {
  const normalizedBase = toPosixPath(baseFilePath);
  const fromDirectory = path.posix.dirname(normalizedBase);
  const joined = path.posix.normalize(path.posix.join(fromDirectory, specifier));
  const extension = path.posix.extname(joined);

  if (extension) {
    return [joined];
  }

  return [
    ...IMPORTABLE_EXTENSIONS.map((candidateExtension) => `${joined}${candidateExtension}`),
    ...IMPORTABLE_EXTENSIONS.map(
      (candidateExtension) => `${joined}/index${candidateExtension}`,
    ),
  ];
}

async function validateChangedFileImports(
  projectDir: string,
  changedFiles: Array<{ path: string; content: string }>,
): Promise<void> {
  const changedFileMap = new Map(
    changedFiles.map((file) => [toPosixPath(file.path), file.content]),
  );

  for (const file of changedFiles) {
    const normalizedFilePath = toPosixPath(file.path);
    if (!/\.(tsx?|jsx?|mjs|cjs)$/i.test(normalizedFilePath)) {
      continue;
    }

    for (const specifier of collectRelativeImports(file.content)) {
      const candidates = importResolutionCandidates(normalizedFilePath, specifier);
      let resolved = false;

      for (const candidate of candidates) {
        if (changedFileMap.has(candidate)) {
          resolved = true;
          break;
        }

        try {
          await fs.access(resolveInsideRoot(projectDir, candidate));
          resolved = true;
          break;
        } catch {
          // Keep checking candidate paths.
        }
      }

      if (!resolved) {
        throw new Error(
          `AI edit would break ${normalizedFilePath}: relative import "${specifier}" does not resolve to a file in the project.`,
        );
      }
    }
  }
}

function validateEditableOverrideSyntax(
  changedFiles: Array<{ path: string; content: string }>,
): void {
  for (const file of changedFiles) {
    if (!isEditableOverridesFile(file.path) || !/\.(?:js|mjs|cjs)$/i.test(file.path)) {
      continue;
    }

    try {
      new vm.Script(file.content, { filename: file.path });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid JavaScript.";
      throw new Error(`AI edit produced invalid code in ${file.path}. ${message}`);
    }
  }
}

function normalizePrompt(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function buildExactSelectedOverrideTarget(selection: SelectionPayload): Record<string, unknown> | null {
  if (selection.scopeSelector && selection.scopedSelector) {
    return {
      scopeSelector: selection.scopeSelector,
      selector: selection.scopedSelector,
    };
  }

  if (selection.selector) {
    return {
      selector: selection.selector,
    };
  }

  if (selection.scopeSelector) {
    return {
      scopeSelector: selection.scopeSelector,
    };
  }

  return null;
}

function buildSelectedContainerOverrideTarget(
  selection: SelectionPayload,
): Record<string, unknown> | null {
  if (selection.scopeSelector) {
    return {
      scopeSelector: selection.scopeSelector,
      selector: "",
    };
  }

  return buildExactSelectedOverrideTarget(selection);
}

function promptRequestsHideSelection(prompt: string): boolean {
  const normalized = normalizePrompt(prompt).toLowerCase();
  return /(?:remove|hide|delete)\s+(?:this|it|selected|selected element|selected layer)/i.test(
    normalized,
  );
}

function extractDirectReplacementText(
  prompt: string,
  selection: SelectionPayload | null,
): string | null {
  const normalizedPrompt = normalizePrompt(prompt);
  const patterns = [
    /^(?:change|replace|rename)\s+this(?:\s+fully)?\s+(?:to|with)\s+["“]?(.+?)["”]?\s*$/i,
    /^(?:change|replace|rename)\s+it\s+(?:to|with)\s+["“]?(.+?)["”]?\s*$/i,
  ];

  for (const pattern of patterns) {
    const match = normalizedPrompt.match(pattern);
    if (match?.[1]) {
      return match[1].trim();
    }
  }

  if (!selection?.textContent) {
    return null;
  }

  const sourceText = normalizePrompt(selection.textContent).toLowerCase();
  if (!sourceText || !normalizedPrompt.toLowerCase().includes(sourceText)) {
    return null;
  }

  const replacementMatch = normalizedPrompt.match(/\b(?:to|with)\b\s+["“]?(.+?)["”]?\s*$/i);
  return replacementMatch?.[1]?.trim() || null;
}

async function tryApplyStaticSelectionFallback(params: {
  projectDir: string;
  prompt: string;
  selection: SelectionPayload | null;
}): Promise<
  | {
      summary: string;
      warnings: string[];
      changedFiles: Array<{ path: string; content: string; reason?: string }>;
    }
  | null
> {
  if (!params.selection) {
    return null;
  }

  if (promptRequestsHideSelection(params.prompt)) {
    const target = buildSelectedContainerOverrideTarget(params.selection);
    if (!target) {
      return null;
    }

    const nextConfig = await appendElementOverride(params.projectDir, {
      ...target,
      hide: true,
    });

    return {
      summary: "Removed the selected layer with a direct override.",
      warnings: [],
      changedFiles: [
        {
          path: OVERRIDES_CONFIG_PATH,
          content: nextConfig,
          reason: "Hide the selected Framer element with a targeted override.",
        },
      ],
    };
  }

  const replacementText = extractDirectReplacementText(params.prompt, params.selection);
  if (!replacementText) {
    return null;
  }

  const target = buildExactSelectedOverrideTarget(params.selection);
  if (!target) {
    return null;
  }

  const nextConfig = await appendElementOverride(params.projectDir, {
    ...target,
    ...(params.selection.textContent
      ? {
          find: params.selection.textContent,
          replace: replacementText,
        }
      : {
          text: replacementText,
        }),
  });

  return {
    summary: params.selection.textContent
      ? `Updated the selected text from "${params.selection.textContent}" to "${replacementText}" using a scoped element override.`
      : `Updated the selected text to "${replacementText}".`,
    warnings: [],
    changedFiles: [
      {
        path: OVERRIDES_CONFIG_PATH,
        content: nextConfig,
        reason: "Update the selected Framer text layer with a direct override.",
      },
    ],
  };
}

async function validateProjectImports(projectDir: string): Promise<void> {
  const projectFiles = await listProjectFiles(projectDir);

  for (const filePath of projectFiles) {
    const normalizedFilePath = toPosixPath(filePath);
    if (!/\.(tsx?|jsx?|mjs|cjs)$/i.test(normalizedFilePath)) {
      continue;
    }

    const content = await readFileIfText(projectDir, normalizedFilePath);
    if (!content) {
      continue;
    }

    for (const specifier of collectRelativeImports(content)) {
      const candidates = importResolutionCandidates(normalizedFilePath, specifier);
      let resolved = false;

      for (const candidate of candidates) {
        try {
          await fs.access(resolveInsideRoot(projectDir, candidate));
          resolved = true;
          break;
        } catch {
          // Keep checking candidate paths.
        }
      }

      if (!resolved) {
        throw new Error(
          `Checkpoint restore would break ${normalizedFilePath}: relative import "${specifier}" does not resolve to a file in the project.`,
        );
      }
    }
  }
}

async function applyPatchOperations(
  projectDir: string,
  operations: Array<{ path: string; search: string; replace: string; reason?: string }>,
): Promise<Array<{ path: string; content: string; reason?: string }>> {
  const fileContents = new Map<string, string>();
  const changedFiles = new Map<string, { content: string; reason?: string }>();

  for (const operation of operations) {
    const normalizedPath = toPosixPath(operation.path.trim());
    if (!normalizedPath) {
      throw new Error("AI patch did not specify a file path.");
    }

    const absolutePath = resolveInsideRoot(projectDir, normalizedPath);
    const currentContent =
      fileContents.get(normalizedPath) || (await fs.readFile(absolutePath, "utf8"));

    if (!operation.search.trim()) {
      throw new Error(`AI patch for ${normalizedPath} did not include any source text to replace.`);
    }

    if (!currentContent.includes(operation.search)) {
      throw new Error(
        `AI patch could not be applied to ${normalizedPath} because the expected source text was not found.`,
      );
    }

    const nextContent = currentContent.replace(operation.search, operation.replace);
    fileContents.set(normalizedPath, nextContent);
    changedFiles.set(normalizedPath, {
      content: nextContent,
      reason: operation.reason,
    });
  }

  return [...changedFiles.entries()].map(([filePath, item]) => ({
    path: filePath,
    content: item.content,
    reason: item.reason,
  }));
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

async function createContextSnapshotRecord(params: {
  projectId: string;
  revisionId?: string | null;
  turnId?: string | null;
  tokenBudget: number;
  primaryTarget?: string | null;
  compressedMemory?: string | null;
  sources: ContextSnapshotRecord["sources"];
}): Promise<ContextSnapshotRecord> {
  const snapshot: ContextSnapshotRecord = {
    id: nanoid(10),
    projectId: params.projectId,
    revisionId: params.revisionId || null,
    turnId: params.turnId || null,
    tokenBudget: params.tokenBudget,
    primaryTarget: params.primaryTarget || null,
    compressedMemory: params.compressedMemory || null,
    sources: params.sources,
    createdAt: nowIso(),
  };

  getDb()
    .prepare(
      `INSERT INTO context_snapshots (
        id, project_id, revision_id, turn_id, token_budget, primary_target,
        compressed_memory, sources_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      snapshot.id,
      snapshot.projectId,
      snapshot.revisionId,
      snapshot.turnId,
      snapshot.tokenBudget,
      snapshot.primaryTarget,
      snapshot.compressedMemory,
      JSON.stringify(snapshot.sources),
      snapshot.createdAt,
    );

  return snapshot;
}

async function createValidationResultRecord(params: {
  projectId: string;
  revisionId?: string | null;
  turnId?: string | null;
  status: ValidationResultRecord["status"];
  buildStatus: ValidationResultRecord["buildStatus"];
  previewStatus: ValidationResultRecord["previewStatus"];
  selectorStatus: ValidationResultRecord["selectorStatus"];
  importsStatus: ValidationResultRecord["importsStatus"];
  designStatus: ValidationResultRecord["designStatus"];
  warnings?: string[];
  details?: string[];
  rawProviderOutput?: string | null;
  retryable?: boolean;
}): Promise<ValidationResultRecord> {
  const validation: ValidationResultRecord = {
    id: nanoid(10),
    projectId: params.projectId,
    revisionId: params.revisionId || null,
    turnId: params.turnId || null,
    status: params.status,
    buildStatus: params.buildStatus,
    previewStatus: params.previewStatus,
    selectorStatus: params.selectorStatus,
    importsStatus: params.importsStatus,
    designStatus: params.designStatus,
    warnings: params.warnings || [],
    details: params.details || [],
    rawProviderOutput: params.rawProviderOutput || null,
    retryable: Boolean(params.retryable),
    createdAt: nowIso(),
  };

  getDb()
    .prepare(
      `INSERT INTO validation_results (
        id, project_id, revision_id, turn_id, status, build_status, preview_status,
        selector_status, imports_status, design_status, warnings_json, details_json,
        raw_provider_output, retryable, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      validation.id,
      validation.projectId,
      validation.revisionId,
      validation.turnId,
      validation.status,
      validation.buildStatus,
      validation.previewStatus,
      validation.selectorStatus,
      validation.importsStatus,
      validation.designStatus,
      JSON.stringify(validation.warnings),
      JSON.stringify(validation.details),
      validation.rawProviderOutput,
      validation.retryable ? 1 : 0,
      validation.createdAt,
    );

  return validation;
}

async function createConversationTurn(params: {
  projectId: string;
  revisionId?: string | null;
  kind: ConversationTurnRecord["kind"];
  status: ConversationTurnRecord["status"];
  prompt?: string | null;
  summary?: string | null;
  aiModelKey?: ConversationTurnRecord["aiModelKey"];
  provider?: ConversationTurnRecord["provider"];
  editMode?: EditMode | null;
  selectionTarget?: SelectionTarget | null;
  changedFiles?: ConversationTurnRecord["changedFiles"];
  warnings?: string[];
  contextSnapshotId?: string | null;
  validationResultId?: string | null;
}): Promise<ConversationTurnRecord> {
  const turn: ConversationTurnRecord = {
    id: nanoid(10),
    projectId: params.projectId,
    revisionId: params.revisionId || null,
    kind: params.kind,
    status: params.status,
    prompt: params.prompt || null,
    summary: params.summary || null,
    aiModelKey: params.aiModelKey || null,
    provider: params.provider || null,
    editMode: params.editMode || null,
    selectionTarget: params.selectionTarget || null,
    changedFiles: params.changedFiles || [],
    warnings: params.warnings || [],
    contextSnapshotId: params.contextSnapshotId || null,
    validationResultId: params.validationResultId || null,
    createdAt: nowIso(),
  };

  getDb()
    .prepare(
      `INSERT INTO conversation_turns (
        id, project_id, revision_id, kind, status, prompt, summary, ai_model_key,
        provider, edit_mode, selection_target_json, changed_files_json, warnings_json,
        context_snapshot_id, validation_result_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      turn.id,
      turn.projectId,
      turn.revisionId,
      turn.kind,
      turn.status,
      turn.prompt,
      turn.summary,
      turn.aiModelKey,
      turn.provider,
      turn.editMode,
      JSON.stringify(turn.selectionTarget),
      JSON.stringify(turn.changedFiles),
      JSON.stringify(turn.warnings),
      turn.contextSnapshotId,
      turn.validationResultId,
      turn.createdAt,
    );

  return turn;
}

async function syncProjectKnowledgeAndKits(
  project: Pick<ProjectRecord, "id" | "name" | "extractedPath" | "packageManager">,
  runtime: ProjectRuntime,
): Promise<KnowledgeArtifacts> {
  const artifacts = await ensureProjectKnowledgeArtifacts({
    projectDir: project.extractedPath,
    projectName: project.name,
    runtime,
    packageManager: project.packageManager,
  });

  const knowledge = await readKnowledgeFiles(project.extractedPath);
  const existing = getMakeKits(project.id);
  const defaults: Array<Omit<MakeKitRecord, "id" | "createdAt" | "updatedAt">> = [
    {
      projectId: project.id,
      name: "Runtime kit",
      kind: "code",
      source: "system",
      enabled: true,
      priority: 100,
      summary: `${runtime.toUpperCase()} project on ${project.packageManager} with candidate files shaped by semantic retrieval.`,
      lockedRules: [
        "Preserve runtime wiring and imports unless the prompt requests a refactor.",
      ],
      softRules: ["Prefer existing components before introducing new structure."],
      assets: [artifacts.componentIndexPath],
    },
    {
      projectId: project.id,
      name: "Visual tokens",
      kind: "style",
      source: "system",
      enabled: true,
      priority: 90,
      summary: `Palette: ${knowledge.brandKit.palette.slice(0, 6).join(", ") || "No palette extracted yet"}`,
      lockedRules: [],
      softRules: ["Use the extracted palette and typography before inventing new styling."],
      assets: [artifacts.brandKitPath],
    },
    {
      projectId: project.id,
      name: "Project rules",
      kind: "rules",
      source: "system",
      enabled: true,
      priority: 80,
      summary: "Project brief and design rules used to ground safe and creative edits.",
      lockedRules: [
        "Keep layout density high and avoid wasted space unless requested.",
      ],
      softRules: ["Respect the project brief and design rules when broadening a design."],
      assets: [artifacts.projectBriefPath, artifacts.designRulesPath, artifacts.editMemoryPath],
    },
  ];

  for (const kit of defaults) {
    const existingKit = existing.find((item) => item.name === kit.name && item.kind === kit.kind);
    if (existingKit) {
      getDb()
        .prepare(
          `UPDATE make_kits
              SET summary = ?, locked_rules_json = ?, soft_rules_json = ?, assets_json = ?,
                  enabled = ?, priority = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(
          kit.summary,
          JSON.stringify(kit.lockedRules),
          JSON.stringify(kit.softRules),
          JSON.stringify(kit.assets),
          kit.enabled ? 1 : 0,
          kit.priority,
          nowIso(),
          existingKit.id,
        );
      continue;
    }

    const createdAt = nowIso();
    getDb()
      .prepare(
        `INSERT INTO make_kits (
          id, project_id, name, kind, source, enabled, priority, summary,
          locked_rules_json, soft_rules_json, assets_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        nanoid(10),
        kit.projectId,
        kit.name,
        kit.kind,
        kit.source,
        kit.enabled ? 1 : 0,
        kit.priority,
        kit.summary,
        JSON.stringify(kit.lockedRules),
        JSON.stringify(kit.softRules),
        JSON.stringify(kit.assets),
        createdAt,
        createdAt,
      );
  }

  return artifacts;
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
  const runtime = requireRuntime(await detectProjectRuntime(project.extractedPath));
  await syncProjectKnowledgeAndKits(project, runtime);
  if (runtime === "static") {
    await ensureStaticEditableOverridesSupport(project.extractedPath);
  }
  let livePreview = getPreviewRunnerInfo(projectId);
  let previewStatus: ProjectWorkspace["preview"]["status"] =
    project.status === "error"
      ? "error"
      : livePreview?.status || (project.status === "ready" ? "starting" : "starting");

  if (options.ensurePreview) {
    try {
      await ensurePreviewRunner(projectId);
      livePreview = getPreviewRunnerInfo(projectId);
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
  } else if (project.status !== "error") {
    warmPreviewRunner(projectId);
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
    conversationTurns: getConversationTurns(projectId),
    attachments: getAttachmentRows(projectId),
    kits: getMakeKits(projectId),
    fileTree: await buildFileTree(project.extractedPath),
    currentFilePath,
    currentFileContent,
    latestContextSnapshot: getLatestContextSnapshot(projectId),
    lastValidationResult: getLatestValidationResult(projectId),
    preview: {
      url: `/preview/${projectId}`,
      status: project.status === "error" ? "error" : previewStatus,
      port: livePreview?.port ?? project.previewPort,
      instanceId: livePreview?.instanceId ?? null,
    },
  };
}

export async function getDashboardSnapshot(
  selectedProjectId?: string | null,
): Promise<DashboardSnapshot> {
  const projects = await listProjects();
  const currentProjectId =
    selectedProjectId && projects.some((project) => project.id === selectedProjectId)
      ? selectedProjectId
      : null;

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

export async function deleteProject(projectId: string): Promise<void> {
  getProjectRow(projectId);

  try {
    await stopPreviewRunner(projectId);
  } catch {
    // Best effort. The project should still be removable if no runner is active.
  }

  getDb().prepare("DELETE FROM projects WHERE id = ?").run(projectId);
  await fs.rm(getProjectPaths(projectId).root, { recursive: true, force: true });
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
  const runtime = requireRuntime(await detectProjectRuntime(projectPaths.current));

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
    await installDependenciesWithRecovery(projectId, projectPaths.current, packageManager);
    await syncProjectKnowledgeAndKits(
      {
        id: projectId,
        name: insertedProject.name,
        extractedPath: projectPaths.current,
        packageManager,
      },
      runtime,
    );
    const manifestHash = await readManifestHash(projectPaths.current);
    getDb()
      .prepare("UPDATE projects SET status = ?, manifest_hash = ? WHERE id = ?")
      .run("ready", manifestHash, projectId);

    const revision = await createRevision({
      projectId,
      label: "Initial upload",
      source: "upload",
      summary: "Imported from uploaded zip archive.",
    });
    const validationResult = await createValidationResultRecord({
      projectId,
      revisionId: revision.id,
      status: "passed",
      buildStatus: "passed",
      previewStatus: "passed",
      selectorStatus: "skipped",
      importsStatus: "passed",
      designStatus: "passed",
      details: ["Initial upload validated and preview runner started successfully."],
    });
    await createConversationTurn({
      projectId,
      revisionId: revision.id,
      kind: "system",
      status: "info",
      summary: "Imported the project and created the first working checkpoint.",
      validationResultId: validationResult.id,
    });

    await ensurePreviewRunner(projectId);
    await fs.rm(unpackDir, { recursive: true, force: true });
    return getWorkspaceSnapshot(projectId, { ensurePreview: false });
  } catch (error) {
    await stopPreviewRunner(projectId).catch(() => undefined);
    getDb().prepare("DELETE FROM projects WHERE id = ?").run(projectId);
    await fs.rm(projectPaths.root, { recursive: true, force: true });
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
  const normalizedContent =
    relativePath === OVERRIDES_CONFIG_PATH ? normalizeOverrideConfigContent(content) : content;
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, normalizedContent, "utf8");

  const nextManifestHash = await readManifestHash(project.extractedPath);
  if (nextManifestHash !== project.manifestHash) {
    await installDependenciesWithRecovery(
      projectId,
      project.extractedPath,
      project.packageManager,
    );
  }

  const runtime = requireRuntime(await detectProjectRuntime(project.extractedPath));
  await syncProjectKnowledgeAndKits(project, runtime);
  const revision = await createRevision({
    projectId,
    label: `Saved ${path.basename(relativePath)}`,
    source: "manual",
    summary: `Updated ${relativePath}`,
  });

  await maybeRefreshPreview(projectId, [relativePath]);
  const validationResult = await createValidationResultRecord({
    projectId,
    revisionId: revision.id,
    status: "passed",
    buildStatus: "passed",
    previewStatus: "passed",
    selectorStatus: "skipped",
    importsStatus: "passed",
    designStatus: "passed",
    details: [`Saved ${relativePath} and synced the preview.`],
  });
  await createConversationTurn({
    projectId,
    revisionId: revision.id,
    kind: "system",
    status: "info",
    summary: `Saved ${relativePath} and created a new checkpoint.`,
    changedFiles: [{ path: relativePath }],
    validationResultId: validationResult.id,
  });
  return getWorkspaceSnapshot(projectId, { currentFilePath: relativePath, ensurePreview: false });
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

  if (created.length) {
    const existingReferenceKit = getMakeKits(projectId).find((kit) => kit.kind === "reference");
    const assets = created.map((item) => item.filename);
    const summary = `Reference files available: ${assets.join(", ")}`;
    if (existingReferenceKit) {
      getDb()
        .prepare(
          `UPDATE make_kits
              SET summary = ?, assets_json = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(
          summary,
          JSON.stringify(
            uniqueStrings([...existingReferenceKit.assets, ...assets]).slice(-12),
          ),
          nowIso(),
          existingReferenceKit.id,
        );
    } else {
      const createdAt = nowIso();
      getDb()
        .prepare(
          `INSERT INTO make_kits (
            id, project_id, name, kind, source, enabled, priority, summary,
            locked_rules_json, soft_rules_json, assets_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          nanoid(10),
          projectId,
          "Reference context",
          "reference",
          "user",
          1,
          70,
          summary,
          JSON.stringify([]),
          JSON.stringify(["Use these references to ground visual and content edits."]),
          JSON.stringify(assets),
          createdAt,
          createdAt,
        );
    }
  }

  return created;
}

async function tryApplyDirectTextReplacement(params: {
  projectDir: string;
  prompt: string;
  selection: SelectionPayload | null;
  selectionTarget: SelectionTarget | null;
  candidateFiles: string[];
}): Promise<
  | {
      summary: string;
      warnings: string[];
      changedFiles: Array<{ path: string; content: string; reason?: string }>;
      rawResponse: string | null;
    }
  | null
> {
  const replacementText = extractDirectReplacementText(params.prompt, params.selection);
  const sourceText = params.selection?.textContent?.trim();
  if (!replacementText || !sourceText) {
    return null;
  }

  const candidateFiles = uniqueStrings(
    [
      params.selectionTarget?.sourceFilePath || "",
      ...params.candidateFiles,
    ].filter(Boolean),
  );

  for (const filePath of candidateFiles) {
    const absolutePath = resolveInsideRoot(params.projectDir, filePath);
    if (!isTextLikeFile(absolutePath)) {
      continue;
    }

    const currentContent = await fs.readFile(absolutePath, "utf8");
    if (!currentContent.includes(sourceText)) {
      continue;
    }

    return {
      summary: `Updated "${sourceText}" to "${replacementText}" directly in ${filePath}.`,
      warnings: [],
      changedFiles: [
        {
          path: filePath,
          content: currentContent.replace(sourceText, replacementText),
          reason: "Direct text replacement from the selected element.",
        },
      ],
      rawResponse: null,
    };
  }

  return null;
}

async function runEditValidation(params: {
  projectId: string;
  projectDir: string;
  changedFiles: Array<{ path: string; content: string; reason?: string }>;
  prompt: string;
  editMode: EditMode;
  selectionTarget: SelectionTarget | null;
  rawProviderOutput: string | null;
}): Promise<Omit<ValidationResultRecord, "id" | "createdAt">> {
  await validateChangedFileImports(params.projectDir, params.changedFiles);
  validateEditableOverrideSyntax(params.changedFiles);
  await validateProjectImports(params.projectDir);

  await maybeRefreshPreview(
    params.projectId,
    params.changedFiles.map((item) => item.path),
  );

  const knowledge = await readKnowledgeFiles(params.projectDir);
  const designValidation = buildDesignValidation({
    prompt: params.prompt,
    editMode: params.editMode,
    changedFiles: params.changedFiles.map((item) => ({
      path: item.path,
      content: item.content,
    })),
    brandKit: knowledge.brandKit,
  });

  const selectorStatus =
    params.selectionTarget && params.changedFiles.length
      ? ("passed" as const)
      : ("skipped" as const);

  const warnings = [...designValidation.warnings];
  const details = [
    "Import resolution passed.",
    "Preview runner booted successfully after the edit.",
    ...designValidation.details,
  ];

  return {
    projectId: params.projectId,
    revisionId: null,
    turnId: null,
    status: designValidation.status === "warning" ? "warning" : "passed",
    buildStatus: "passed",
    previewStatus: "passed",
    selectorStatus,
    importsStatus: "passed",
    designStatus: designValidation.status,
    warnings,
    details,
    rawProviderOutput: params.rawProviderOutput,
    retryable: false,
  };
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
  const runtime = requireRuntime(await detectProjectRuntime(project.extractedPath));
  await syncProjectKnowledgeAndKits(project, runtime);
  if (runtime === "static") {
    await ensureStaticEditableOverridesSupport(project.extractedPath);
  }

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

  const projectFiles = await listProjectFiles(project.extractedPath);
  const recentTurns = getConversationTurns(payload.projectId).slice(-12);
  const kits = getMakeKits(payload.projectId);
  const effectiveCurrentFilePath = resolvePreferredAiFilePath(
    projectFiles,
    payload.currentFilePath,
  );
  const editMode: EditMode = payload.editMode || "scoped";
  const route = payload.selection?.route || "/";
  const activeFileContent =
    effectiveCurrentFilePath &&
    isTextLikeFile(path.join(project.extractedPath, effectiveCurrentFilePath))
      ? await fs.readFile(path.join(project.extractedPath, effectiveCurrentFilePath), "utf8")
      : null;

  const knowledge = await readKnowledgeFiles(project.extractedPath);
  const selectionTarget = await buildSelectionTarget({
    projectDir: project.extractedPath,
    route,
    currentFilePath: effectiveCurrentFilePath,
    selection: payload.selection,
    componentIndex: knowledge.componentIndex,
  });
  const contextGraph = await collectContextGraph({
    projectDir: project.extractedPath,
    route,
    currentFilePath: effectiveCurrentFilePath,
    prompt: payload.prompt,
    selection: payload.selection,
    selectionTarget,
    kits,
    recentTurns,
    attachments: attachmentRows.map(mapAttachmentRow),
  });
  const editPlan = buildEditPlan({
    currentFilePath: effectiveCurrentFilePath,
    currentFileContent: activeFileContent,
    editMode,
    prompt: payload.prompt,
    runtime,
    selectionTarget,
    contextGraph,
    hasStaticEditableSupport: hasStaticEditableOverrides(projectFiles),
  });
  const activeKitSummaries = describeKitAssets(kits);
  const provider =
    (payload.aiModelKey || DEFAULT_AI_MODEL_KEY).startsWith("openai")
      ? "openai"
      : "anthropic";

  const userTurn = await createConversationTurn({
    projectId: payload.projectId,
    kind: "user",
    status: "pending",
    prompt: payload.prompt.trim(),
    aiModelKey: payload.aiModelKey || DEFAULT_AI_MODEL_KEY,
    provider,
    editMode,
    selectionTarget,
  });
  const contextSnapshot = await createContextSnapshotRecord({
    projectId: payload.projectId,
    revisionId: currentRevision.id,
    turnId: userTurn.id,
    tokenBudget: contextGraph.tokenBudget,
    primaryTarget: contextGraph.primaryTarget,
    compressedMemory: contextGraph.compressedMemory,
    sources: contextGraph.sources,
  });
  getDb()
    .prepare(
      `UPDATE conversation_turns
          SET context_snapshot_id = ?
        WHERE id = ?`,
    )
    .run(contextSnapshot.id, userTurn.id);

  let aiResult:
    | {
        summary: string;
        warnings: string[];
        changedFiles: Array<{ path: string; content: string; reason?: string }>;
        rawResponse: string | null;
      }
    | {
        summary: string;
        warnings: string[];
        operations: Array<{ path: string; search: string; replace: string; reason?: string }>;
        rawResponse: string | null;
      };

  let changedFiles: Array<{ path: string; content: string; reason?: string }>;
  const canUseStaticSelectionFallback =
    runtime === "static" && hasStaticEditableOverrides(projectFiles);
  const strategyQueue = uniqueStrings(
    [
      editPlan.strategy,
      editPlan.strategy !== "patch" && effectiveCurrentFilePath ? "patch" : "",
      canUseStaticSelectionFallback ? "static-override" : "",
    ].filter(Boolean),
  ) as EditPlan["strategy"][];

  let lastAttemptError: unknown = null;
  aiResult = {
    summary: "",
    warnings: [],
    changedFiles: [],
    rawResponse: null,
  };
  changedFiles = [];

  for (const strategy of strategyQueue) {
    try {
      if (strategy === "direct-property") {
        const directResult = await tryApplyDirectTextReplacement({
          projectDir: project.extractedPath,
          prompt: payload.prompt,
          selection: payload.selection,
          selectionTarget,
          candidateFiles: editPlan.candidateFiles,
        });
        if (!directResult) {
          throw new Error("Direct property mode could not safely resolve this change.");
        }
        aiResult = directResult;
        changedFiles = directResult.changedFiles;
        break;
      }

      if (strategy === "static-override") {
        const staticResult = await tryApplyStaticSelectionFallback({
          projectDir: project.extractedPath,
          prompt: payload.prompt,
          selection: payload.selection,
        });
        if (!staticResult) {
          throw new Error("Static override mode could not resolve this change.");
        }
        aiResult = {
          ...staticResult,
          rawResponse: null,
        };
        changedFiles = staticResult.changedFiles;
        break;
      }

      if (strategy === "patch" && effectiveCurrentFilePath) {
        aiResult = await requestAiPatchEdit({
          aiModelKey: payload.aiModelKey,
          prompt: payload.prompt,
          editMode,
          selection: payload.selection,
          selectionTarget,
          editPlan: {
            ...editPlan,
            strategy,
          },
          currentFilePath: effectiveCurrentFilePath,
          contextFiles: contextGraph.contextFiles,
          contextSummary: contextGraph.compressedMemory,
          activeKitSummaries,
          attachments,
        });
        changedFiles = await applyPatchOperations(project.extractedPath, aiResult.operations);
        break;
      }

      aiResult = await requestAiEdit({
        aiModelKey: payload.aiModelKey,
        prompt: payload.prompt,
        editMode,
        selection: payload.selection,
        selectionTarget,
        editPlan: {
          ...editPlan,
          strategy,
        },
        currentFilePath: effectiveCurrentFilePath,
        contextFiles: contextGraph.contextFiles,
        contextSummary: contextGraph.compressedMemory,
        activeKitSummaries,
        attachments,
      });
      changedFiles = aiResult.changedFiles;
      break;
    } catch (error) {
      lastAttemptError = error;
    }
  }

  if (!changedFiles.length) {
    const validationResult = await createValidationResultRecord({
      projectId: payload.projectId,
      revisionId: currentRevision.id,
      status: "failed",
      buildStatus: "failed",
      previewStatus: "skipped",
      selectorStatus: selectionTarget ? "warning" : "skipped",
      importsStatus: "failed",
      designStatus: "skipped",
      warnings: [],
      details: [
        lastAttemptError instanceof Error
          ? lastAttemptError.message
          : "The edit planner could not produce a safe change set.",
      ],
      rawProviderOutput: aiResult.rawResponse,
      retryable: true,
    });
    await createConversationTurn({
      projectId: payload.projectId,
      revisionId: currentRevision.id,
      kind: "assistant",
      status: "failed",
      summary:
        lastAttemptError instanceof Error
          ? lastAttemptError.message
          : "The edit could not be applied safely.",
      aiModelKey: payload.aiModelKey || DEFAULT_AI_MODEL_KEY,
      provider,
      editMode,
      selectionTarget,
      contextSnapshotId: contextSnapshot.id,
      validationResultId: validationResult.id,
      warnings: validationResult.warnings,
    });
    getDb()
      .prepare(`UPDATE conversation_turns SET status = ? WHERE id = ?`)
      .run("failed", userTurn.id);
    throw lastAttemptError instanceof Error
      ? lastAttemptError
      : new Error("The AI edit request failed.");
  }

  changedFiles = changedFiles.map((file) =>
    file.path === OVERRIDES_CONFIG_PATH
      ? {
          ...file,
          content: normalizeOverrideConfigContent(file.content),
        }
      : file,
  );

  const changedPaths: string[] = [];
  for (const change of changedFiles) {
    const absolutePath = resolveInsideRoot(project.extractedPath, change.path);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, change.content, "utf8");
    changedPaths.push(toPosixPath(change.path));
  }

  const nextManifestHash = await readManifestHash(project.extractedPath);
  if (nextManifestHash !== project.manifestHash) {
    await installDependenciesWithRecovery(
      payload.projectId,
      project.extractedPath,
      project.packageManager,
    );
  }
  let validationResultData: Omit<ValidationResultRecord, "id" | "createdAt">;
  try {
    validationResultData = await runEditValidation({
      projectId: payload.projectId,
      projectDir: project.extractedPath,
      changedFiles,
      prompt: payload.prompt,
      editMode,
      selectionTarget,
      rawProviderOutput: aiResult.rawResponse,
    });
  } catch (error) {
    await syncSnapshotToCurrent(currentRevision.snapshotPath, project.extractedPath);
    if (runtime === "static") {
      await ensureStaticEditableOverridesSupport(project.extractedPath);
    }
    const rollbackManifestHash = await readManifestHash(project.extractedPath);
    if (rollbackManifestHash !== project.manifestHash) {
      await installDependenciesWithRecovery(
        payload.projectId,
        project.extractedPath,
        project.packageManager,
      );
    }
    await restartPreviewRunner(payload.projectId).catch(() => undefined);
    const failedValidation = await createValidationResultRecord({
      projectId: payload.projectId,
      revisionId: currentRevision.id,
      status: "failed",
      buildStatus: "failed",
      previewStatus: "failed",
      selectorStatus: selectionTarget ? "warning" : "skipped",
      importsStatus: "failed",
      designStatus: "skipped",
      details: [
        error instanceof Error ? error.message : "Validation failed after applying the edit.",
      ],
      rawProviderOutput: aiResult.rawResponse,
      retryable: true,
    });
    await createConversationTurn({
      projectId: payload.projectId,
      revisionId: currentRevision.id,
      kind: "assistant",
      status: "failed",
      summary:
        error instanceof Error
          ? error.message
          : "The edit failed validation and was rolled back.",
      aiModelKey: payload.aiModelKey || DEFAULT_AI_MODEL_KEY,
      provider,
      editMode,
      selectionTarget,
      changedFiles: changedFiles.map((item) => ({ path: item.path, reason: item.reason })),
      warnings: failedValidation.warnings,
      contextSnapshotId: contextSnapshot.id,
      validationResultId: failedValidation.id,
    });
    getDb()
      .prepare(`UPDATE conversation_turns SET status = ? WHERE id = ?`)
      .run("failed", userTurn.id);
    throw error instanceof Error
      ? new Error(`${error.message} MyMake rolled back to the last working checkpoint.`)
      : new Error("The edit failed validation and was rolled back.");
  }

  const revision = await createRevision({
    projectId: payload.projectId,
    label: payload.prompt.trim(),
    source: "ai",
    summary: aiResult.summary,
  });

  const validationResult = await createValidationResultRecord({
    ...validationResultData,
    revisionId: revision.id,
  });
  const assistantTurn = await createConversationTurn({
    projectId: payload.projectId,
    revisionId: revision.id,
    kind: "assistant",
    status: "applied",
    summary: aiResult.summary,
    aiModelKey: payload.aiModelKey || DEFAULT_AI_MODEL_KEY,
    provider,
    editMode,
    selectionTarget,
    changedFiles: changedFiles.map((item) => ({ path: item.path, reason: item.reason })),
    warnings: [...aiResult.warnings, ...validationResult.warnings],
    contextSnapshotId: contextSnapshot.id,
    validationResultId: validationResult.id,
  });
  getDb()
    .prepare(
      `UPDATE validation_results
          SET turn_id = ?
        WHERE id = ?`,
    )
    .run(assistantTurn.id, validationResult.id);
  getDb()
    .prepare(`UPDATE conversation_turns SET status = ? WHERE id = ?`)
    .run("applied", userTurn.id);
  await updateEditMemory({
    projectDir: project.extractedPath,
    prompt: payload.prompt.trim(),
    summary: aiResult.summary,
    editMode,
    target: selectionTarget,
    changedFiles: changedPaths,
    createdAt: revision.createdAt,
  });
    await syncProjectKnowledgeAndKits(getProjectRow(payload.projectId), runtime);
  return {
    summary: aiResult.summary,
    warnings: [...aiResult.warnings, ...validationResult.warnings],
    changedFiles: changedFiles.map((item) => ({
      path: item.path,
      reason: item.reason,
    })),
    workspace: await getWorkspaceSnapshot(payload.projectId, {
      currentFilePath: effectiveCurrentFilePath || changedPaths[0] || null,
      ensurePreview: false,
    }),
  };
}

async function switchToRevision(
  projectId: string,
  targetRevision: RevisionRecord,
): Promise<ProjectWorkspace> {
  const project = getProjectRow(projectId);
  const currentRevision = project.currentRevisionId
    ? getRevisionById(project.currentRevisionId)
    : null;

  if (currentRevision?.id === targetRevision.id) {
    return getWorkspaceSnapshot(projectId, { ensurePreview: false });
  }

  try {
    await syncSnapshotToCurrent(targetRevision.snapshotPath, project.extractedPath);
    if (requireRuntime(await detectProjectRuntime(project.extractedPath)) === "static") {
      await ensureStaticEditableOverridesSupport(project.extractedPath);
    }
    await validateProjectImports(project.extractedPath);

    const restoredManifestHash = await readManifestHash(project.extractedPath);
    if (restoredManifestHash !== project.manifestHash) {
      await installDependenciesWithRecovery(projectId, project.extractedPath, project.packageManager);
    }

    await restartPreviewRunner(projectId);
    getDb()
      .prepare(
        `UPDATE projects
            SET current_revision_id = ?, manifest_hash = ?, status = ?, last_opened_at = ?
          WHERE id = ?`,
      )
      .run(targetRevision.id, restoredManifestHash, "ready", nowIso(), projectId);
    await syncProjectKnowledgeAndKits(
      getProjectRow(projectId),
      requireRuntime(await detectProjectRuntime(project.extractedPath)),
    );

    return getWorkspaceSnapshot(projectId, { ensurePreview: false });
  } catch (error) {
    if (currentRevision) {
      await syncSnapshotToCurrent(currentRevision.snapshotPath, project.extractedPath);

      const rollbackManifestHash = await readManifestHash(project.extractedPath);
      if (rollbackManifestHash !== project.manifestHash) {
        await installDependenciesWithRecovery(projectId, project.extractedPath, project.packageManager);
      }

      getDb()
        .prepare(
          `UPDATE projects
              SET current_revision_id = ?, manifest_hash = ?, status = ?, last_opened_at = ?
            WHERE id = ?`,
        )
        .run(currentRevision.id, rollbackManifestHash, project.status, nowIso(), projectId);

      try {
        await restartPreviewRunner(projectId);
      } catch {
        // Best effort rollback. Surface the original restore error below.
      }
    }

    const checkpointNumber = targetRevision.sequence + 1;
    const reason = error instanceof Error ? error.message : "Restore failed.";
    throw new Error(
      `Could not restore Checkpoint ${checkpointNumber}. MyMake rolled the project back to the last working revision. ${reason}`,
    );
  }
}

export async function restoreProjectRevision(
  projectId: string,
  revisionId: string,
): Promise<ProjectWorkspace> {
  const targetRevision = getRevisionById(revisionId);
  if (targetRevision.projectId !== projectId) {
    throw new Error("That checkpoint does not belong to this project.");
  }

  const workspace = await switchToRevision(projectId, targetRevision);
  const validationResult = await createValidationResultRecord({
    projectId,
    revisionId: targetRevision.id,
    status: "passed",
    buildStatus: "passed",
    previewStatus: "passed",
    selectorStatus: "skipped",
    importsStatus: "passed",
    designStatus: "passed",
    details: [`Restored ${`#${String(targetRevision.sequence + 1).padStart(2, "0")}`}.`],
  });
  await createConversationTurn({
    projectId,
    revisionId: targetRevision.id,
    kind: "system",
    status: "info",
    summary: `Restored ${`#${String(targetRevision.sequence + 1).padStart(2, "0")}`}.`,
    validationResultId: validationResult.id,
  });
  return workspace;
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

  const targetRevision = mapRevisionRow(previousRow);
  const workspace = await switchToRevision(projectId, targetRevision);
  const validationResult = await createValidationResultRecord({
    projectId,
    revisionId: targetRevision.id,
    status: "passed",
    buildStatus: "passed",
    previewStatus: "passed",
    selectorStatus: "skipped",
    importsStatus: "passed",
    designStatus: "passed",
    details: [`Moved back to ${`#${String(targetRevision.sequence + 1).padStart(2, "0")}`}.`],
  });
  await createConversationTurn({
    projectId,
    revisionId: targetRevision.id,
    kind: "system",
    status: "info",
    summary: `Moved back to ${`#${String(targetRevision.sequence + 1).padStart(2, "0")}`}.`,
    validationResultId: validationResult.id,
  });
  return workspace;
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

  const targetRevision = mapRevisionRow(nextRow);
  const workspace = await switchToRevision(projectId, targetRevision);
  const validationResult = await createValidationResultRecord({
    projectId,
    revisionId: targetRevision.id,
    status: "passed",
    buildStatus: "passed",
    previewStatus: "passed",
    selectorStatus: "skipped",
    importsStatus: "passed",
    designStatus: "passed",
    details: [`Moved forward to ${`#${String(targetRevision.sequence + 1).padStart(2, "0")}`}.`],
  });
  await createConversationTurn({
    projectId,
    revisionId: targetRevision.id,
    kind: "system",
    status: "info",
    summary: `Moved forward to ${`#${String(targetRevision.sequence + 1).padStart(2, "0")}`}.`,
    validationResultId: validationResult.id,
  });
  return workspace;
}

export async function createProjectExport(projectId: string): Promise<string> {
  const project = getProjectRow(projectId);
  const outputPath = path.join(getProjectPaths(projectId).root, `export-${Date.now()}.zip`);
  await archiveDirectoryToFile(project.extractedPath, outputPath);
  return outputPath;
}
