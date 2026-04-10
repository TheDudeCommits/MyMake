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
  status: RunnerStatus;
  process: ChildProcess;
}

interface PreviewRuntimeState {
  activeProjectId: string | null;
  runners: Map<string, PreviewRunnerState>;
}

declare global {
  // eslint-disable-next-line no-var
  var __MYMAKE_PREVIEW_RUNTIME__: PreviewRuntimeState | undefined;
}

function getRuntimeState(): PreviewRuntimeState {
  if (!global.__MYMAKE_PREVIEW_RUNTIME__) {
    global.__MYMAKE_PREVIEW_RUNTIME__ = {
      activeProjectId: null,
      runners: new Map(),
    };
  }

  return global.__MYMAKE_PREVIEW_RUNTIME__;
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

async function getRunnerSpec(
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
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: "development",
      HOST: "127.0.0.1",
      PORT: String(port),
      BROWSER: "none",
    };

    if (packageManager === "pnpm") {
      return {
        command: "pnpm",
        args: ["dev", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
        env,
      };
    }

    if (packageManager === "yarn") {
      return {
        command: "yarn",
        args: ["dev", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
        env,
      };
    }

    return {
      command: "npm",
      args: ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
      env,
    };
  }

  throw new Error("Unsupported preview runtime for this project.");
}

export async function stopPreviewRunner(projectId: string): Promise<void> {
  const runtime = getRuntimeState();
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
  const existing = runtime.runners.get(projectId);
  if (existing && existing.status !== "error" && !existing.process.killed) {
    return existing;
  }

  if (runtime.activeProjectId && runtime.activeProjectId !== projectId) {
    await stopPreviewRunner(runtime.activeProjectId);
  }

  const project = await loadProject(projectId);
  await normalizeImportedProject(project.extracted_path);
  const port = project.preview_port || (await getAvailablePort());
  const targetUrl = `http://127.0.0.1:${port}`;
  const runnerSpec = await getRunnerSpec(project.extracted_path, project.package_manager, port);

  const child = spawn(runnerSpec.command, runnerSpec.args, {
    cwd: project.extracted_path,
    env: runnerSpec.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const runner: PreviewRunnerState = {
    projectId,
    port,
    targetUrl,
    status: "starting",
    process: child,
  };

  runtime.runners.set(projectId, runner);
  runtime.activeProjectId = projectId;

  child.stdout?.on("data", (chunk) => {
    process.stdout.write(`[preview:${projectId}] ${chunk}`);
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
    runner.status = "ready";
    getDb()
      .prepare(
        `UPDATE projects
            SET preview_port = ?, status = ?, last_opened_at = ?
          WHERE id = ?`,
      )
      .run(port, "ready", new Date().toISOString(), projectId);
    return runner;
  } catch (error) {
    runner.status = "error";
    await stopPreviewRunner(projectId);
    throw error;
  }
}

export async function restartPreviewRunner(projectId: string): Promise<void> {
  await stopPreviewRunner(projectId);
  await ensurePreviewRunner(projectId);
}

export async function getPreviewTargetUrl(projectId: string): Promise<string> {
  const runtime = getRuntimeState();
  const existing = runtime.runners.get(projectId);
  if (existing) {
    return existing.targetUrl;
  }

  const runner = await ensurePreviewRunner(projectId);
  return runner.targetUrl;
}

export function getActivePreviewProjectId(): string | null {
  return getRuntimeState().activeProjectId;
}
