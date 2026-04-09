import fs from "node:fs/promises";
import path from "node:path";

import type { PackageManager } from "@/lib/types";

interface ValidationResult {
  ok: boolean;
  packageManager: PackageManager;
  reason?: string;
}

const DISALLOWED_DEPENDENCIES = [
  "@neondatabase/serverless",
  "drizzle-orm",
  "ioredis",
  "mongodb",
  "mongoose",
  "mysql",
  "mysql2",
  "pg",
  "prisma",
  "redis",
  "sqlite3",
  "socket.io",
  "typeorm",
];

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function detectPackageManager(projectDir: string): Promise<PackageManager> {
  if (await pathExists(path.join(projectDir, "pnpm-lock.yaml"))) {
    return "pnpm";
  }

  if (await pathExists(path.join(projectDir, "yarn.lock"))) {
    return "yarn";
  }

  return "npm";
}

export async function validateProjectDirectory(projectDir: string): Promise<ValidationResult> {
  const packageJsonPath = path.join(projectDir, "package.json");
  if (!(await pathExists(packageJsonPath))) {
    return {
      ok: false,
      packageManager: "npm",
      reason: "The uploaded zip does not contain a package.json file.",
    };
  }

  const packageManager = await detectPackageManager(projectDir);
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    workspaces?: unknown;
  };

  if (packageJson.workspaces) {
    return {
      ok: false,
      packageManager,
      reason: "Monorepos are not supported in v1. Upload a single Next.js frontend app instead.",
    };
  }

  const dependencies = {
    ...(packageJson.dependencies || {}),
    ...(packageJson.devDependencies || {}),
  };

  const hasNext = Boolean(dependencies.next);
  const hasReact = Boolean(dependencies.react);
  const hasReactDom = Boolean(dependencies["react-dom"]);
  if (!hasNext || !hasReact || !hasReactDom) {
    return {
      ok: false,
      packageManager,
      reason: "The uploaded project must be a Next.js app with React and React DOM.",
    };
  }

  const hasAppRouter = await pathExists(path.join(projectDir, "app"));
  const hasPagesRouter = await pathExists(path.join(projectDir, "pages"));
  if (!hasAppRouter && !hasPagesRouter) {
    return {
      ok: false,
      packageManager,
      reason: "The uploaded project must include an app/ or pages/ directory.",
    };
  }

  if (await pathExists(path.join(projectDir, "app", "api"))) {
    return {
      ok: false,
      packageManager,
      reason: "Projects with app/api routes are out of scope for MyMake v1.",
    };
  }

  if (await pathExists(path.join(projectDir, "pages", "api"))) {
    return {
      ok: false,
      packageManager,
      reason: "Projects with pages/api routes are out of scope for MyMake v1.",
    };
  }

  for (const dependency of DISALLOWED_DEPENDENCIES) {
    if (dependency in dependencies) {
      return {
        ok: false,
        packageManager,
        reason: `This project depends on ${dependency}, which usually requires external services that v1 does not run.`,
      };
    }
  }

  return { ok: true, packageManager };
}
