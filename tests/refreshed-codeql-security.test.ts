import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { assertLoopbackWebSocketUrl } from "@/lib/server/figma-make-clone";
import {
  ensureProjectKnowledgeArtifacts,
  PROJECT_BRIEF_PATH,
} from "@/lib/server/project-intelligence";

test("Figma plugin WebSocket endpoints are restricted to local loopback", () => {
  assert.equal(
    assertLoopbackWebSocketUrl("ws://127.0.0.1:8765"),
    "ws://127.0.0.1:8765/",
  );
  assert.equal(
    assertLoopbackWebSocketUrl("ws://localhost:8765"),
    "ws://localhost:8765/",
  );

  for (const value of [
    "wss://127.0.0.1:8765",
    "ws://example.com:8765",
    "ws://user:password@127.0.0.1:8765",
  ]) {
    assert.throws(() => assertLoopbackWebSocketUrl(value), /loopback/);
  }
});

test("request-supplied project names are not persisted into knowledge files", async () => {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "mymake-knowledge-"));
  const untrustedProjectName = "network-supplied\r\nforged-content";

  await ensureProjectKnowledgeArtifacts({
    projectDir,
    projectName: untrustedProjectName,
    runtime: "next",
    packageManager: "npm",
  });

  const projectBrief = await fs.readFile(
    path.join(projectDir, PROJECT_BRIEF_PATH),
    "utf8",
  );
  assert.doesNotMatch(projectBrief, /network-supplied|forged-content/);
  assert.match(projectBrief, /Project: Local workspace/);
});

test("preview messaging and workspace uploads retain their trust-boundary guards", async () => {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const workspaceSource = await fs.readFile(
    path.join(repositoryRoot, "components/workspace-app.tsx"),
    "utf8",
  );
  const bridgeSource = await fs.readFile(
    path.join(repositoryRoot, "scripts/codex-bridge.ts"),
    "utf8",
  );

  assert.match(workspaceSource, /event\.origin !== previewOrigin/);
  assert.match(workspaceSource, /event\.source !== iframeRef\.current\?\.contentWindow/);
  assert.doesNotMatch(workspaceSource, /postMessage\([\s\S]{0,240}"\*"/);
  assert.match(
    bridgeSource,
    /const enforceWorkspaceRateLimit = rateLimit\(\{/,
  );
  assert.match(
    bridgeSource,
    /"\/v1\/projects\/:projectId\/workspace",\s+enforceWorkspaceRateLimit,/,
  );
});
