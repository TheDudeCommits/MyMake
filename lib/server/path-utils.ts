import fs from "node:fs/promises";
import path from "node:path";
import mime from "mime-types";

import type { FileNode } from "@/lib/types";

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".mymake",
  ".next",
  "node_modules",
  "__MACOSX",
]);

const TEXT_EXTENSIONS = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mdx",
  ".mjs",
  ".scss",
  ".svg",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);

export function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const SAFE_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function assertSafePathSegment(value: string, label = "Path segment"): string {
  if (!SAFE_PATH_SEGMENT_PATTERN.test(value)) {
    throw new Error(`${label} contains invalid characters.`);
  }

  return value;
}

export function resolveInsideRoot(root: string, relativePath: string): string {
  if (!path.isAbsolute(root)) {
    throw new Error("Path root must be absolute.");
  }
  if (CONTROL_CHARACTER_PATTERN.test(relativePath)) {
    throw new Error("Path contains control characters.");
  }
  if (
    path.isAbsolute(relativePath) ||
    /^[\\/]/.test(relativePath) ||
    /^[A-Za-z]:[\\/]/.test(relativePath)
  ) {
    throw new Error("Path must be relative to the project root.");
  }
  if (relativePath.split(/[\\/]+/).includes("..")) {
    throw new Error("Path traversal segments are not allowed.");
  }

  const resolvedRoot = path.resolve(root);
  const portableRelativePath = relativePath.replace(/[\\/]/g, path.sep);
  const resolved = path.resolve(resolvedRoot, portableRelativePath);
  const containmentPath = path.relative(resolvedRoot, resolved);
  if (
    containmentPath === ".." ||
    containmentPath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(containmentPath)
  ) {
    throw new Error("Path escapes the project root.");
  }

  return resolved;
}

export function shouldIgnoreEntry(entryName: string): boolean {
  return IGNORED_DIRECTORIES.has(entryName) || entryName === ".DS_Store";
}

export function isTextLikeFile(filePath: string): boolean {
  const extension = path.extname(filePath).toLowerCase();
  if (TEXT_EXTENSIONS.has(extension)) {
    return true;
  }

  const guessed = mime.lookup(filePath);
  return typeof guessed === "string" && guessed.startsWith("text/");
}

async function buildTreeRecursive(root: string, current: string): Promise<FileNode[]> {
  const entries = await fs.readdir(current, { withFileTypes: true });
  const items: Array<FileNode | null> = await Promise.all(
    entries
      .filter((entry) => !shouldIgnoreEntry(entry.name))
      .filter((entry) => !entry.isSymbolicLink())
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(async (entry) => {
        const relativePath = toPosixPath(path.join(path.relative(root, current), entry.name));
        const absolutePath = resolveInsideRoot(root, relativePath);

        if (entry.isDirectory()) {
          const children = await buildTreeRecursive(root, absolutePath);
          if (!children.length) {
            return null;
          }

          return {
            name: entry.name,
            path: relativePath,
            type: "directory" as const,
            editable: false,
            children,
          };
        }

        return {
          name: entry.name,
          path: relativePath,
          type: "file" as const,
          editable: isTextLikeFile(absolutePath),
        };
      }),
  );

  return items.filter((item): item is FileNode => item !== null);
}

export async function buildFileTree(root: string): Promise<FileNode[]> {
  return buildTreeRecursive(root, root);
}

export async function listProjectFiles(root: string): Promise<string[]> {
  const output: string[] = [];

  async function walk(current: string) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (shouldIgnoreEntry(entry.name)) {
        continue;
      }
      if (entry.isSymbolicLink()) {
        continue;
      }

      const relativePath = toPosixPath(path.join(path.relative(root, current), entry.name));
      const absolutePath = resolveInsideRoot(root, relativePath);
      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }

      output.push(relativePath);
    }
  }

  await walk(root);
  return output.sort();
}
