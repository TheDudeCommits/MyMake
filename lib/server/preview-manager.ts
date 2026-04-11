import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";

import { getDb } from "@/lib/server/db";
import { detectProjectRuntime, normalizeImportedProject } from "@/lib/server/project-validation";
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

const MAX_WARM_PREVIEW_RUNNERS = 2;
const STALE_RUNNER_TTL_MS = 15 * 60 * 1000;

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
    try {
      const response = await fetch(targetUrl, { redirect: "manual" });
      if (response.status < 400) {
        return;
      }
    } catch {
      // The runner is still warming up.
    }

    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error("Timed out while starting the project preview.");
}

async function loadProject(projectId: string) {
  const row = getDb()
    .prepare(
      `SELECT id, extracted_path, package_manager, preview_port
         FROM projects
        WHERE id = ?`,
    )
    .get(projectId) as
    | {
        id: string;
        extracted_path: string;
        package_manager: PackageManager;
        preview_port: number | null;
      }
    | undefined;

  if (!row) {
    throw new Error("Project not found.");
  }

  return row;
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

async function getRunnerSpec(
  projectId: string,
  projectDir: string,
  packageManager: PackageManager,
  port: number,
): Promise<{
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
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
    touchRunner(existing);
    return existing;
  }

  const startPromise = (async () => {
    await prunePreviewRunners(projectId);

    const project = await loadProject(projectId);
    await normalizeImportedProject(project.extracted_path);
    const port = project.preview_port || (await getAvailablePort());
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
    });

    try {
      await waitForRunner(targetUrl);
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
