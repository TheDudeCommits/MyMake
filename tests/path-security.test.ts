import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import AdmZip from "adm-zip";

import { GuidelineStore } from "@/lib/server/guidelines";
import {
  assertSafePathSegment,
  buildFileTree,
  listProjectFiles,
  resolveInsideRoot,
} from "@/lib/server/path-utils";
import {
  extractZipBufferToDirectory,
  getProjectPaths,
} from "@/lib/server/storage";

async function temporaryDirectory(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function zipWithEntryName(entryName: string, replacementName?: string): Buffer {
  const archive = new AdmZip();
  archive.addFile(entryName, Buffer.from("unsafe"));
  const buffer = archive.toBuffer();
  if (!replacementName) {
    return buffer;
  }

  const original = Buffer.from(entryName);
  const replacement = Buffer.from(replacementName);
  assert.equal(replacement.length, original.length);

  let offset = 0;
  let replacements = 0;
  while ((offset = buffer.indexOf(original, offset)) >= 0) {
    replacement.copy(buffer, offset);
    offset += original.length;
    replacements += 1;
  }
  assert.equal(replacements, 2);
  return buffer;
}

test("resolveInsideRoot rejects traversal, absolute paths, and sibling-prefix escapes", async () => {
  const parent = await temporaryDirectory("mymake-path-root-");
  const root = path.join(parent, "project");
  await fs.mkdir(root);

  assert.equal(resolveInsideRoot(root, "src/app.tsx"), path.join(root, "src", "app.tsx"));
  assert.throws(() => resolveInsideRoot(root, "../project-other/secret.txt"), /traversal/);
  assert.throws(() => resolveInsideRoot(root, "..\\project-other\\secret.txt"), /traversal/);
  assert.throws(() => resolveInsideRoot(root, "src/../secret.txt"), /traversal/);
  assert.throws(() => resolveInsideRoot(root, path.join(parent, "absolute.txt")), /relative/);
  assert.throws(() => resolveInsideRoot(root, "C:\\absolute.txt"), /relative/);
  assert.throws(() => resolveInsideRoot(root, "safe\u0000name.txt"), /control/);
});

test("safe path segments accept generated IDs and reject path syntax", () => {
  for (const value of ["abc123", "_nanoid", "-nanoid", "revision_1-2"]) {
    assert.equal(assertSafePathSegment(value), value);
  }

  for (const value of ["", ".", "..", "../project", "project/name", "project\\name", "bad\nid"]) {
    assert.throws(() => assertSafePathSegment(value), /invalid/);
  }
  assert.throws(() => getProjectPaths("../outside"), /invalid/);
});

test("zip extraction rejects traversal entries without writing outside the destination", async () => {
  const parent = await temporaryDirectory("mymake-zip-root-");
  const destination = path.join(parent, "destination");
  const outsidePath = path.join(parent, "evil.txt");
  const maliciousZip = zipWithEntryName("aa/evil.txt", "../evil.txt");

  await assert.rejects(
    extractZipBufferToDirectory(maliciousZip, destination),
    /traversal/,
  );
  await assert.rejects(fs.access(outsidePath));
});

test("zip extraction writes normal nested files inside the destination", async () => {
  const parent = await temporaryDirectory("mymake-zip-safe-");
  const destination = path.join(parent, "destination");
  const archive = new AdmZip();
  archive.addFile("src/index.ts", Buffer.from("export {};\n"));

  await extractZipBufferToDirectory(archive.toBuffer(), destination);
  assert.equal(
    await fs.readFile(path.join(destination, "src", "index.ts"), "utf8"),
    "export {};\n",
  );
});

test("project file walkers do not follow symbolic links", async (context) => {
  const parent = await temporaryDirectory("mymake-symlink-root-");
  const root = path.join(parent, "project");
  const outsidePath = path.join(parent, "outside.txt");
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, "inside.txt"), "inside");
  await fs.writeFile(outsidePath, "outside");

  try {
    await fs.symlink(outsidePath, path.join(root, "linked.txt"));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EPERM") {
      context.skip("Symbolic links are unavailable in this environment.");
      return;
    }
    throw error;
  }

  assert.deepEqual(await listProjectFiles(root), ["inside.txt"]);
  assert.deepEqual(
    (await buildFileTree(root)).map((entry) => entry.path),
    ["inside.txt"],
  );
});

test("guideline storage rejects paths outside its managed root", async () => {
  const parent = await temporaryDirectory("mymake-guideline-root-");
  const root = path.join(parent, "guidelines");
  const store = new GuidelineStore({ rootDir: root });

  assert.throws(() => store.addGuideline("../outside.md", "# Outside"), /inside/);
  assert.throws(() => store.addGuideline("..\\outside.md", "# Outside"), /inside/);
  await assert.rejects(fs.access(path.join(parent, "outside.md")));
});
