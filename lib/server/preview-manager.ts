import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";

import { getDb } from "@/lib/server/db";
import {
  detectProjectRuntime,
  normalizeImportedProject,
  runtimeRequiresDependencyInstall,
} from "@/lib/server/project-validation";
import { resolveInsideRoot } from "@/lib/server/path-utils";
import { getProjectPaths } from "@/lib/server/storage";
import type { PackageManager } from "@/lib/types";

type RunnerStatus = "starting" | "ready" | "error";

interface PreviewRunnerState {
  projectId: string;
  port: number;
  targetUrl: string;
  instanceId: string;
  lastAccessedAt: number;
  status: RunnerStatus;
  process: ChildProcess;
}

interface PreviewRuntimeState {
  activeProjectId: string | null;
  runners: Map<string, PreviewRunnerState>;
  startPromises: Map<string, Promise<PreviewRunnerState>>;
}

const MAX_WARM_PREVIEW_RUNNERS = 4;
const STALE_RUNNER_TTL_MS = 30 * 60 * 1000;

declare global {
  // eslint-disable-next-line no-var
  var __MYMAKE_PREVIEW_RUNTIME__: PreviewRuntimeState | undefined;
}

function getRuntimeState(): PreviewRuntimeState {
  if (!global.__MYMAKE_PREVIEW_RUNTIME__) {
    global.__MYMAKE_PREVIEW_RUNTIME__ = {
      activeProjectId: null,
      runners: new Map(),
      startPromises: new Map(),
    };
  }

  return global.__MYMAKE_PREVIEW_RUNTIME__;
}

function touchRunner(runner: PreviewRunnerState): void {
  runner.lastAccessedAt = Date.now();
  getRuntimeState().activeProjectId = runner.projectId;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Could not allocate a preview port."));
        return;
      }

      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(port);
      });
    });
    server.on("error", reject);
  });
}

async function waitForRunner(targetUrl: string): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (await canReachRunner(targetUrl, 2_000)) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error("Timed out while starting the project preview.");
}

async function canReachRunner(targetUrl: string, timeoutMs = 1_500): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(targetUrl, {
      redirect: "manual",
      signal: controller.signal,
    });
    return response.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function loadProject(projectId: string) {
  const row = getDb()
    .prepare(
      `SELECT id, extracted_path, package_manager, preview_port, manifest_hash
         FROM projects
        WHERE id = ?`,
    )
    .get(projectId) as
    | {
        id: string;
        extracted_path: string;
        package_manager: PackageManager;
        preview_port: number | null;
        manifest_hash: string | null;
      }
    | undefined;

  if (!row) {
    throw new Error("Project not found.");
  }

  return row;
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

async function runInstallCommand(
  command: string,
  args: string[],
  cwd: string,
  label: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: installEnvironment(),
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

async function installDependencies(projectDir: string, packageManager: PackageManager): Promise<void> {
  if (packageManager === "pnpm") {
    await runInstallCommand("pnpm", ["install", "--prod=false"], projectDir, "pnpm install");
    return;
  }

  if (packageManager === "yarn") {
    await runInstallCommand(
      "yarn",
      ["install", "--production=false"],
      projectDir,
      "yarn install",
    );
    return;
  }

  await runInstallCommand("npm", ["install", "--include=dev"], projectDir, "npm install");
}

function isNoSpaceError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /ENOSPC|no space left on device/i.test(message);
}

async function cleanupProjectInstallArtifacts(projectId: string): Promise<void> {
  const paths = getProjectPaths(projectId);

  await Promise.all([
    fs.rm(resolveInsideRoot(paths.current, "node_modules"), { recursive: true, force: true }),
    fs.rm(resolveInsideRoot(paths.current, ".next"), { recursive: true, force: true }),
    fs.rm(resolveInsideRoot(paths.root, "unpacked"), { recursive: true, force: true }),
  ]);

  const rootEntries = await fs.readdir(paths.root).catch(() => [] as string[]);
  await Promise.all(
    rootEntries
      .filter((entry) => /^export-\d+(?:-[A-Za-z0-9_-]+)?\.zip$/.test(entry))
      .map((entry) =>
        fs.rm(resolveInsideRoot(paths.root, entry), {
          force: true,
        }),
      ),
  );
}

export async function reclaimProjectInstallStorage(preferredProjectId: string): Promise<void> {
  const rows = getDb()
    .prepare(
      `SELECT id
         FROM projects
        WHERE id != ?
        ORDER BY last_opened_at ASC`,
    )
    .all(preferredProjectId) as Array<{ id: string }>;

  for (const row of rows) {
    await stopPreviewRunner(row.id).catch(() => undefined);
    await cleanupProjectInstallArtifacts(row.id);
  }
}

async function ensureProjectDependenciesInstalled(project: {
  id: string;
  extracted_path: string;
  package_manager: PackageManager;
  manifest_hash: string | null;
}): Promise<void> {
  const runtime = await detectProjectRuntime(project.extracted_path);
  if (!runtimeRequiresDependencyInstall(runtime)) {
    return;
  }

  const nodeModulesPath = resolveInsideRoot(project.extracted_path, "node_modules");
  if (await pathExists(nodeModulesPath)) {
    return;
  }

  getDb()
    .prepare(
      `UPDATE projects
          SET status = ?, preview_port = NULL, last_opened_at = ?
        WHERE id = ?`,
    )
    .run("installing", new Date().toISOString(), project.id);

  try {
    try {
      await installDependencies(project.extracted_path, project.package_manager);
    } catch (error) {
      if (!isNoSpaceError(error)) {
        throw error;
      }

      await cleanupProjectInstallArtifacts(project.id);
      await reclaimProjectInstallStorage(project.id);
      await installDependencies(project.extracted_path, project.package_manager);
    }

    getDb()
      .prepare(
        `UPDATE projects
            SET status = ?, last_opened_at = ?
          WHERE id = ?`,
      )
      .run("ready", new Date().toISOString(), project.id);
  } catch (error) {
    getDb()
      .prepare(
        `UPDATE projects
            SET status = ?, preview_port = NULL, last_opened_at = ?
          WHERE id = ?`,
      )
      .run("error", new Date().toISOString(), project.id);
    throw error;
  }
}

function nextRunnerCommandArgs(projectDir: string, port: number): string[] {
  return [
    path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"),
    path.join(process.cwd(), "scripts", "project-preview-runner.ts"),
    "--projectDir",
    projectDir,
    "--port",
    String(port),
  ];
}

function nextViteRunnerCommandArgs(projectDir: string, projectId: string, port: number): string[] {
  return [
    path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"),
    path.join(process.cwd(), "scripts", "project-vite-preview-runner.ts"),
    "--projectDir",
    projectDir,
    "--projectId",
    projectId,
    "--port",
    String(port),
  ];
}

function staticRunnerCommandArgs(projectDir: string, port: number): string[] {
  return [
    path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"),
    path.join(process.cwd(), "scripts", "project-static-preview-runner.ts"),
    "--projectDir",
    projectDir,
    "--port",
    String(port),
  ];
}

async function getRunnerSpec(
  projectId: string,
  projectDir: string,
  packageManager: PackageManager,
  port: number,
): Promise<{
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  readyStrategy: "http" | "stdout-or-http";
}> {
  const runtime = await detectProjectRuntime(projectDir);
  if (runtime === "next") {
    return {
      command: process.execPath,
      args: nextRunnerCommandArgs(projectDir, port),
      env: {
        ...process.env,
        NODE_ENV: "development",
      },
      readyStrategy: "stdout-or-http",
    };
  }

  if (runtime === "vite") {
    return {
      command: process.execPath,
      args: nextViteRunnerCommandArgs(projectDir, projectId, port),
      env: {
        ...process.env,
        NODE_ENV: "development",
      },
      readyStrategy: "stdout-or-http",
    };
  }

  if (runtime === "static") {
    return {
      command: process.execPath,
      args: staticRunnerCommandArgs(projectDir, port),
      env: {
        ...process.env,
        NODE_ENV: "development",
      },
      readyStrategy: "stdout-or-http",
    };
  }

  throw new Error("Unsupported preview runtime for this project.");
}

function markRunnerReady(runner: PreviewRunnerState): void {
  if (runner.status === "ready") {
    touchRunner(runner);
    return;
  }

  runner.status = "ready";
  touchRunner(runner);
  getDb()
    .prepare(
      `UPDATE projects
          SET preview_port = ?, status = ?, last_opened_at = ?
        WHERE id = ?`,
    )
    .run(runner.port, "ready", new Date().toISOString(), runner.projectId);
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

async function prunePreviewRunners(preferredProjectId: string): Promise<void> {
  const runtime = getRuntimeState();
  const now = Date.now();
  const candidates = [...runtime.runners.values()]
    .filter(
      (runner) =>
        runner.projectId !== preferredProjectId &&
        !runtime.startPromises.has(runner.projectId),
    )
    .sort((left, right) => left.lastAccessedAt - right.lastAccessedAt);

  for (const runner of candidates) {
    if (runtime.runners.size <= MAX_WARM_PREVIEW_RUNNERS) {
      break;
    }

    if (now - runner.lastAccessedAt < STALE_RUNNER_TTL_MS) {
      continue;
    }

    await stopPreviewRunner(runner.projectId);
  }

  while (runtime.runners.size >= MAX_WARM_PREVIEW_RUNNERS && candidates.length) {
    const oldestRunner = candidates.shift();
    if (!oldestRunner) {
      break;
    }

    if (!runtime.runners.has(oldestRunner.projectId)) {
      continue;
    }

    await stopPreviewRunner(oldestRunner.projectId);
  }
}

export async function stopPreviewRunner(projectId: string): Promise<void> {
  const runtime = getRuntimeState();
  runtime.startPromises.delete(projectId);
  const runner = runtime.runners.get(projectId);
  if (!runner) {
    return;
  }

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      runner.process.kill("SIGKILL");
      resolve();
    }, 5_000);

    runner.process.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });

    runner.process.kill("SIGTERM");
  });

  runtime.runners.delete(projectId);
  if (runtime.activeProjectId === projectId) {
    runtime.activeProjectId = null;
  }
}

export async function ensurePreviewRunner(projectId: string): Promise<PreviewRunnerState> {
  const runtime = getRuntimeState();
  const pendingStart = runtime.startPromises.get(projectId);
  if (pendingStart) {
    return pendingStart;
  }

  const existing = runtime.runners.get(projectId);
  if (existing && existing.status !== "error" && !existing.process.killed) {
    if (existing.status !== "ready" || (await canReachRunner(existing.targetUrl))) {
      touchRunner(existing);
      return existing;
    }

    await stopPreviewRunner(projectId);
  }

  const startPromise = (async () => {
    await prunePreviewRunners(projectId);

    const project = await loadProject(projectId);
    await normalizeImportedProject(project.extracted_path);
    await ensureProjectDependenciesInstalled(project);
    const port = await getAvailablePort();
    const targetUrl = `http://127.0.0.1:${port}`;
    const runnerSpec = await getRunnerSpec(
      projectId,
      project.extracted_path,
      project.package_manager,
      port,
    );

    const child = spawn(runnerSpec.command, runnerSpec.args, {
      cwd: project.extracted_path,
      env: runnerSpec.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const runner: PreviewRunnerState = {
      projectId,
      port,
      targetUrl,
      instanceId: randomUUID(),
      lastAccessedAt: Date.now(),
      status: "starting",
      process: child,
    };

    runtime.runners.set(projectId, runner);
    touchRunner(runner);
    let stdoutBuffer = "";
    let resolveReadySignal: (() => void) | null = null;
    let rejectReadySignal: ((error: Error) => void) | null = null;
    const readySignal = new Promise<void>((resolve, reject) => {
      resolveReadySignal = resolve;
      rejectReadySignal = reject;
    });

    child.stdout?.on("data", (chunk) => {
      const text = String(chunk);
      process.stdout.write(`[preview:${projectId}] ${text}`);
      stdoutBuffer = `${stdoutBuffer}${stripAnsi(text)}`.slice(-8_000);
      if (
        stdoutBuffer.includes(`http://127.0.0.1:${port}/`) ||
        stdoutBuffer.includes(`http://127.0.0.1:${port}`) ||
        stdoutBuffer.includes("Preview runner ready") ||
        /ready in\s+\d+/i.test(stdoutBuffer)
      ) {
        markRunnerReady(runner);
        resolveReadySignal?.();
        resolveReadySignal = null;
        rejectReadySignal = null;
      }
    });
    child.stderr?.on("data", (chunk) => {
      process.stderr.write(`[preview:${projectId}] ${chunk}`);
    });
    child.once("exit", () => {
      runtime.runners.delete(projectId);
      if (runtime.activeProjectId === projectId) {
        runtime.activeProjectId = null;
      }

      if (runner.status !== "ready") {
        rejectReadySignal?.(new Error("Preview runner exited before it became ready."));
        rejectReadySignal = null;
        resolveReadySignal = null;
      }
    });

    try {
      if (runnerSpec.readyStrategy === "stdout-or-http") {
        await Promise.race([readySignal, waitForRunner(targetUrl)]);
      } else {
        await waitForRunner(targetUrl);
      }
      markRunnerReady(runner);
      return runner;
    } catch (error) {
      runner.status = "error";
      getDb()
        .prepare(
          `UPDATE projects
              SET preview_port = NULL, status = ?, last_opened_at = ?
            WHERE id = ?`,
        )
        .run("error", new Date().toISOString(), projectId);
      await stopPreviewRunner(projectId);
      throw error;
    } finally {
      runtime.startPromises.delete(projectId);
    }
  })();

  runtime.startPromises.set(projectId, startPromise);
  return startPromise;
}

export async function restartPreviewRunner(projectId: string): Promise<void> {
  await stopPreviewRunner(projectId);
  await ensurePreviewRunner(projectId);
}

export async function getPreviewTargetUrl(projectId: string): Promise<string> {
  const runtime = getRuntimeState();
  const existing = runtime.runners.get(projectId);
  if (existing) {
    touchRunner(existing);
    return existing.targetUrl;
  }

  const runner = await ensurePreviewRunner(projectId);
  return runner.targetUrl;
}

export function getActivePreviewProjectId(): string | null {
  return getRuntimeState().activeProjectId;
}

export function getPreviewRunnerInfo(projectId: string): {
  status: RunnerStatus;
  port: number;
  targetUrl: string;
  instanceId: string;
} | null {
  const runner = getRuntimeState().runners.get(projectId);
  if (!runner || runner.process.killed) {
    return null;
  }

  return {
    status: runner.status,
    port: runner.port,
    targetUrl: runner.targetUrl,
    instanceId: runner.instanceId,
  };
}

export function warmPreviewRunner(projectId: string): void {
  const runtime = getRuntimeState();
  const existing = runtime.runners.get(projectId);

  if (existing && existing.status !== "error" && !existing.process.killed) {
    touchRunner(existing);
    return;
  }

  if (runtime.startPromises.has(projectId)) {
    return;
  }

  void ensurePreviewRunner(projectId).catch((error) => {
    process.stderr.write(`[preview:${projectId}] warm start failed: ${String(error)}\n`);
  });
}
