import fs from "node:fs/promises";
import path from "node:path";
import mime from "mime-types";

import type { FileNode } from "@/lib/types";

const IGNORED_DIRECTORIES = new Set([
  ".git",
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

export function resolveInsideRoot(root: string, relativePath: string): string {
  const normalized = path.normalize(relativePath).replace(/^(\.\.(\/|\\|$))+/, "");
  const resolved = path.resolve(root, normalized);

  if (!resolved.startsWith(path.resolve(root))) {
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
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(async (entry) => {
        const absolutePath = path.join(current, entry.name);
        const relativePath = toPosixPath(path.relative(root, absolutePath));

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

      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }

      output.push(toPosixPath(path.relative(root, absolutePath)));
    }
  }

  await walk(root);
  return output.sort();
}
