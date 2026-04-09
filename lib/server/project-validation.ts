import fs from "node:fs/promises";
import path from "node:path";

import type { PackageManager, ProjectRuntime } from "@/lib/types";

interface ProjectManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  scripts?: Record<string, string>;
  workspaces?: unknown;
}

interface ValidationResult {
  ok: boolean;
  packageManager: PackageManager;
  runtime?: ProjectRuntime;
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

const TEXT_SOURCE_EXTENSIONS = new Set([
  ".css",
  ".html",
  ".js",
  ".jsx",
  ".json",
  ".md",
  ".mdx",
  ".mjs",
  ".ts",
  ".tsx",
]);

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function listFiles(rootDir: string, currentDir = rootDir): Promise<string[]> {
  const entries = await fs.readdir(currentDir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const absolutePath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(rootDir, absolutePath)));
      continue;
    }

    files.push(path.relative(rootDir, absolutePath));
  }

  return files;
}

async function readManifest(projectDir: string): Promise<ProjectManifest | null> {
  const packageJsonPath = path.join(projectDir, "package.json");
  if (!(await pathExists(packageJsonPath))) {
    return null;
  }

  return JSON.parse(await fs.readFile(packageJsonPath, "utf8")) as ProjectManifest;
}

function collectManifestDependencies(manifest: ProjectManifest): Record<string, string> {
  return {
    ...(manifest.dependencies || {}),
    ...(manifest.devDependencies || {}),
    ...(manifest.peerDependencies || {}),
  };
}

export async function detectProjectRuntime(projectDir: string): Promise<ProjectRuntime | null> {
  const manifest = await readManifest(projectDir);
  if (!manifest) {
    return null;
  }

  const dependencies = collectManifestDependencies(manifest);
  const devScript = manifest.scripts?.dev || "";
  const buildScript = manifest.scripts?.build || "";
  const scriptText = `${devScript} ${buildScript}`.toLowerCase();

  if (dependencies.next || scriptText.includes("next")) {
    return "next";
  }

  if (
    dependencies.vite ||
    scriptText.includes("vite") ||
    (await pathExists(path.join(projectDir, "vite.config.ts"))) ||
    (await pathExists(path.join(projectDir, "vite.config.js"))) ||
    (await pathExists(path.join(projectDir, "vite.config.mjs")))
  ) {
    return "vite";
  }

  return null;
}

export async function normalizeImportedProject(projectDir: string): Promise<void> {
  const packageJsonPath = path.join(projectDir, "package.json");
  const manifest = await readManifest(projectDir);
  if (!manifest) {
    return;
  }

  const peerDependencies = manifest.peerDependencies || {};
  const devDependencies = manifest.devDependencies || {};
  const nextDependencies = {
    ...(manifest.dependencies || {}),
  };

  let changed = false;
  for (const dependency of ["react", "react-dom"]) {
    if (
      !nextDependencies[dependency] &&
      !devDependencies[dependency] &&
      peerDependencies[dependency]
    ) {
      nextDependencies[dependency] = peerDependencies[dependency];
      changed = true;
    }
  }

  if (changed) {
    manifest.dependencies = nextDependencies;
    await fs.writeFile(packageJsonPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }

  const assetRoot = path.join(projectDir, "src", "assets");
  if (!(await pathExists(assetRoot))) {
    return;
  }

  const assetFiles = new Set(
    (await listFiles(assetRoot)).map((relativePath) => relativePath.split(path.sep).join("/")),
  );
  const projectFiles = await listFiles(projectDir);

  for (const relativePath of projectFiles) {
    const extension = path.extname(relativePath).toLowerCase();
    if (!TEXT_SOURCE_EXTENSIONS.has(extension)) {
      continue;
    }

    const absolutePath = path.join(projectDir, relativePath);
    const originalContent = await fs.readFile(absolutePath, "utf8");
    const nextContent = originalContent.replace(/figma:asset\/([A-Za-z0-9._-]+)/g, (match, assetName) => {
      if (!assetFiles.has(assetName)) {
        return match;
      }

      const sourceDirectory = path.dirname(absolutePath);
      const assetPath = path.join(assetRoot, assetName);
      const relativeAssetPath = path.relative(sourceDirectory, assetPath).split(path.sep).join("/");
      return relativeAssetPath.startsWith(".") ? relativeAssetPath : `./${relativeAssetPath}`;
    });

    if (nextContent !== originalContent) {
      await fs.writeFile(absolutePath, nextContent, "utf8");
    }
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
  const manifest = await readManifest(projectDir);
  if (!manifest) {
    return {
      ok: false,
      packageManager: "npm",
      reason: "The uploaded zip does not contain a package.json file.",
    };
  }

  const packageManager = await detectPackageManager(projectDir);
  if (manifest.workspaces) {
    return {
      ok: false,
      packageManager,
      reason: "Monorepos are not supported in v1. Upload a single frontend app instead.",
    };
  }

  const dependencies = collectManifestDependencies(manifest);
  const runtime = await detectProjectRuntime(projectDir);
  if (!runtime) {
    return {
      ok: false,
      packageManager,
      reason: "The uploaded project must be a supported React frontend app built with Next.js or Vite.",
    };
  }

  const hasNext = Boolean(dependencies.next);
  const hasVite = Boolean(dependencies.vite);
  const hasReact = Boolean(dependencies.react);
  const hasReactDom = Boolean(dependencies["react-dom"]);
  if ((!hasNext && !hasVite) || !hasReact || !hasReactDom) {
    return {
      ok: false,
      packageManager,
      reason: "The uploaded project must include React and React DOM, and use Next.js or Vite.",
    };
  }

  if (runtime === "next") {
    const hasAppRouter = await pathExists(path.join(projectDir, "app"));
    const hasPagesRouter = await pathExists(path.join(projectDir, "pages"));
    if (!hasAppRouter && !hasPagesRouter) {
      return {
        ok: false,
        packageManager,
        reason: "Next.js uploads must include an app/ or pages/ directory.",
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
  }

  if (runtime === "vite") {
    const hasIndexHtml = await pathExists(path.join(projectDir, "index.html"));
    const hasEntryPoint =
      (await pathExists(path.join(projectDir, "src", "main.tsx"))) ||
      (await pathExists(path.join(projectDir, "src", "main.jsx"))) ||
      (await pathExists(path.join(projectDir, "src", "main.ts"))) ||
      (await pathExists(path.join(projectDir, "src", "main.js")));

    if (!hasIndexHtml || !hasEntryPoint) {
      return {
        ok: false,
        packageManager,
        reason: "Vite uploads must include index.html and a src/main.* entry file.",
      };
    }
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

  return { ok: true, packageManager, runtime };
}
