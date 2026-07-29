import AdmZip from "adm-zip";
import { ZipArchive } from "archiver";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { getEnv, resolveConfiguredStorageRoot } from "@/lib/server/env";
import {
  assertSafePathSegment,
  resolveInsideRoot,
  shouldIgnoreEntry,
} from "@/lib/server/path-utils";

export interface ProjectPaths {
  root: string;
  current: string;
  revisions: string;
  attachments: string;
  sourceZip: string;
}

function shouldCopySource(sourcePath: string): boolean {
  const baseName = path.basename(sourcePath);
  return !shouldIgnoreEntry(baseName);
}

export function getProjectPaths(projectId: string): ProjectPaths {
  const safeProjectId = assertSafePathSegment(projectId, "Project ID");
  const storageRoot = resolveConfiguredStorageRoot(getEnv().storageRoot);
  const projectsRoot = resolveInsideRoot(storageRoot, "projects");
  const root = resolveInsideRoot(projectsRoot, safeProjectId);
  return {
    root,
    current: resolveInsideRoot(root, "current"),
    revisions: resolveInsideRoot(root, "revisions"),
    attachments: resolveInsideRoot(root, "attachments"),
    sourceZip: resolveInsideRoot(root, "source.zip"),
  };
}

export async function ensureStorageReady(): Promise<void> {
  const storageRoot = resolveConfiguredStorageRoot(getEnv().storageRoot);
  await fsp.mkdir(storageRoot, { recursive: true });
  await fsp.mkdir(resolveInsideRoot(storageRoot, "projects"), { recursive: true });
}

export async function ensureProjectDirectories(projectId: string): Promise<ProjectPaths> {
  const paths = getProjectPaths(projectId);
  await fsp.mkdir(paths.root, { recursive: true });
  await fsp.mkdir(paths.current, { recursive: true });
  await fsp.mkdir(paths.revisions, { recursive: true });
  await fsp.mkdir(paths.attachments, { recursive: true });
  return paths;
}

export async function clearDirectoryExcept(
  directoryPath: string,
  preservedEntries: Set<string>,
): Promise<void> {
  await fsp.mkdir(directoryPath, { recursive: true });
  const entries = await fsp.readdir(directoryPath);
  await Promise.all(
    entries.map(async (entry) => {
      if (preservedEntries.has(entry)) {
        return;
      }

      await fsp.rm(resolveInsideRoot(directoryPath, entry), {
        recursive: true,
        force: true,
      });
    }),
  );
}

export async function copyProjectDirectory(source: string, destination: string): Promise<void> {
  await fsp.rm(destination, { recursive: true, force: true });
  await fsp.mkdir(destination, { recursive: true });
  await fsp.cp(source, destination, {
    recursive: true,
    force: true,
    filter: (originPath) => shouldCopySource(originPath),
  });
}

export async function syncSnapshotToCurrent(
  snapshotPath: string,
  currentPath: string,
): Promise<void> {
  await clearDirectoryExcept(currentPath, new Set(["node_modules", ".next"]));
  await fsp.cp(snapshotPath, currentPath, {
    recursive: true,
    force: true,
    filter: (originPath) => shouldCopySource(originPath),
  });
}

export async function createRevisionSnapshot(
  projectId: string,
  revisionId: string,
): Promise<string> {
  const paths = await ensureProjectDirectories(projectId);
  const snapshotPath = resolveInsideRoot(
    paths.revisions,
    assertSafePathSegment(revisionId, "Revision ID"),
  );
  await copyProjectDirectory(paths.current, snapshotPath);
  return snapshotPath;
}

export async function extractZipBufferToDirectory(
  buffer: Buffer,
  destination: string,
): Promise<void> {
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

export async function archiveDirectoryToFile(
  source: string,
  outputFilePath: string,
): Promise<void> {
  await fsp.mkdir(path.dirname(outputFilePath), { recursive: true });

  await new Promise<void>((resolve, reject) => {
    const output = fs.createWriteStream(outputFilePath);
    const archive = new ZipArchive({ zlib: { level: 9 } });

    output.on("close", () => resolve());
    output.on("error", reject);
    archive.on("error", reject);

    archive.pipe(output);
    archive.glob("**/*", {
      cwd: source,
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
