import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { GetFileResponse } from "@figma/rest-api-spec/dist/api_types";

import {
  FigmaMakeClone,
  type DesignModelClient,
  type DesignModelInvocation,
  type FigmaPluginBridge,
  type FigmaPluginExecutionResult,
} from "@/lib/server/figma-make-clone";

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function readTextFileOrNull(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}

function createFileResponse(title: string): GetFileResponse {
  return {
    document: {
      id: "0:0",
      name: "Document",
      type: "DOCUMENT",
      visible: true,
      locked: false,
      scrollBehavior: "SCROLLS",
      children: [
        {
          id: "1:0",
          name: "Page",
          type: "CANVAS",
          visible: true,
          locked: false,
          scrollBehavior: "SCROLLS",
          backgroundColor: { r: 1, g: 1, b: 1, a: 1 },
          prototypeStartNodeID: null,
          flowStartingPoints: [],
          prototypeDevice: { type: "NONE", rotation: "NONE" },
          exportSettings: [],
          children: [
            {
              id: "2:0",
              name: "Root Frame",
              type: "FRAME",
              visible: true,
              locked: false,
              scrollBehavior: "SCROLLS",
              absoluteBoundingBox: { x: 0, y: 0, width: 400, height: 220 },
              absoluteRenderBounds: { x: 0, y: 0, width: 400, height: 220 },
              blendMode: "PASS_THROUGH",
              opacity: 1,
              clipsContent: false,
              layoutMode: "VERTICAL",
              primaryAxisAlignItems: "MIN",
              counterAxisAlignItems: "MIN",
              paddingTop: 24,
              paddingRight: 24,
              paddingBottom: 24,
              paddingLeft: 24,
              itemSpacing: 12,
              fills: [],
              strokes: [],
              effects: [],
              exportSettings: [],
              children: [
                {
                  id: "2:1",
                  name: "Title",
                  type: "TEXT",
                  visible: true,
                  locked: false,
                  scrollBehavior: "SCROLLS",
                  absoluteBoundingBox: { x: 24, y: 24, width: 280, height: 40 },
                  absoluteRenderBounds: { x: 24, y: 24, width: 280, height: 40 },
                  blendMode: "NORMAL",
                  opacity: 1,
                  fills: [],
                  effects: [],
                  exportSettings: [],
                  characters: title,
                  style: {
                    fontFamily: "Inter",
                    fontStyle: "Bold",
                    fontWeight: 700,
                    fontSize: 24,
                    fills: [],
                  },
                  characterStyleOverrides: [],
                  styleOverrideTable: {},
                  lineTypes: ["NONE"],
                  lineIndentations: [0],
                },
              ],
            },
          ],
        },
      ],
    },
    components: {},
    componentSets: {},
    styles: {},
    schemaVersion: 0,
    name: "Test file",
    role: "owner",
    lastModified: "2026-04-13T00:00:00.000Z",
    thumbnailUrl: "",
    version: "1",
    editorType: "figma",
  } as unknown as GetFileResponse;
}

class MockDesignModelClient implements DesignModelClient {
  readonly invocations: DesignModelInvocation[] = [];

  constructor(private readonly responses: string[]) {}

  async complete(input: DesignModelInvocation): Promise<string> {
    this.invocations.push(input);
    const next = this.responses.shift();
    if (!next) {
      throw new Error("No mock AI response queued.");
    }
    return next;
  }
}

class MockPluginClient implements FigmaPluginBridge {
  executeCalls = 0;
  createVersionCalls: string[] = [];
  restoreVersionCalls: string[] = [];
  executedCode: string[] = [];

  constructor(
    private readonly executionResults: FigmaPluginExecutionResult[] = [
      { success: true, nodeIds: { title: "2:1" } },
    ],
    private readonly thumbnail = "data:image/png;base64,thumb",
  ) {}

  async executeCode(code: string): Promise<FigmaPluginExecutionResult> {
    this.executeCalls += 1;
    this.executedCode.push(code);
    return this.executionResults.shift() ?? { success: true, nodeIds: {} };
  }

  async createVersion(label: string): Promise<string | null> {
    this.createVersionCalls.push(label);
    return `version-${this.createVersionCalls.length}`;
  }

  async restoreVersion(versionId: string): Promise<void> {
    this.restoreVersionCalls.push(versionId);
  }

  async getPreviewThumbnail(): Promise<string | null> {
    return this.thumbnail;
  }
}

function createFetchMock(states: GetFileResponse[]): typeof fetch {
  let fileIndex = 0;

  return (async (input) => {
    const url = String(input);
    if (url.includes("/variables/local")) {
      return new Response("{}", { status: 404 });
    }
    if (url.includes("/v1/files/")) {
      const payload = states[Math.min(fileIndex, states.length - 1)] ?? states.at(-1);
      fileIndex += 1;
      return new Response(JSON.stringify(payload), { status: 200 });
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  }) as typeof fetch;
}

test("handlePrompt supports dry-run without executing plugin code", async () => {
  const root = tempDir("mymake-figma-dryrun-");
  const ai = new MockDesignModelClient([
    [
      "I will update the selected text.",
      "```json",
      JSON.stringify(
        [
          {
            action: "modify",
            nodeId: "2:1",
            updates: {
              type: "TEXT",
              content: "Updated title",
            },
          },
        ],
        null,
        2,
      ),
      "```",
    ].join("\n"),
  ]);
  const plugin = new MockPluginClient();

  const clone = new FigmaMakeClone({
    projectId: "dry-run-project",
    stateDir: root,
    fileKey: "file-key",
    rootNodeId: "2:0",
    figmaToken: "figma-token",
    fetchImpl: createFetchMock([createFileResponse("Original title")]),
    aiClients: { openai: ai },
    pluginClient: plugin,
    defaultModelProfile: "fast",
    initialProjectDescription: "Design a simple dashboard.",
  });

  const result = await clone.handlePrompt("Rename the title", [], {
    dryRun: true,
    modelProfile: "fast",
  });

  assert.equal(result.success, true);
  assert.equal(result.dryRun, true);
  assert.equal(plugin.executeCalls, 0);
  assert.equal(result.operations.length > 0, true);
  assert.equal(result.previewThumbnail, "data:image/png;base64,thumb");
  assert.equal(result.checkpoint, null);
});

test("handlePrompt retries after an invalid AI response and creates a checkpoint on success", async () => {
  const root = tempDir("mymake-figma-retry-");
  const ai = new MockDesignModelClient([
    "this is not valid operation json",
    [
      "Updated the title to the new copy.",
      "```json",
      JSON.stringify(
        [
          {
            action: "modify",
            nodeId: "2:1",
            updates: {
              type: "TEXT",
              content: "New title",
            },
          },
        ],
        null,
        2,
      ),
      "```",
    ].join("\n"),
  ]);
  const plugin = new MockPluginClient();
  const clone = new FigmaMakeClone({
    projectId: "retry-project",
    stateDir: root,
    fileKey: "file-key",
    rootNodeId: "2:0",
    figmaToken: "figma-token",
    fetchImpl: createFetchMock([
      createFileResponse("Original title"),
      createFileResponse("New title"),
    ]),
    aiClients: { openai: ai },
    pluginClient: plugin,
    defaultModelProfile: "fast",
  });

  const result = await clone.handlePrompt("Update the title text", [], {
    modelProfile: "fast",
    maxRetries: 2,
  });

  assert.equal(result.success, true);
  assert.equal(ai.invocations.length, 2);
  assert.equal(plugin.executeCalls, 1);
  assert.ok(result.checkpoint);
  assert.equal(result.checkpoint?.figmaVersionId, "version-2");
  assert.equal(result.designStateHash !== null, true);

  const snapshotsPath = path.join(root, "figma-make-clone", "retry-project", "design-state-history.json");
  const snapshots = JSON.parse(fs.readFileSync(snapshotsPath, "utf8")) as Array<{ designStateHash: string }>;
  assert.equal(snapshots.length >= 2, true);
});

test("restoreCheckpoint restores local state and calls plugin restoreVersion", async () => {
  const root = tempDir("mymake-figma-restore-");
  const ai = new MockDesignModelClient([
    [
      "Updated the title.",
      "```json",
      JSON.stringify(
        [
          {
            action: "modify",
            nodeId: "2:1",
            updates: {
              type: "TEXT",
              content: "Restored title",
            },
          },
        ],
        null,
        2,
      ),
      "```",
    ].join("\n"),
  ]);
  const plugin = new MockPluginClient();
  const clone = new FigmaMakeClone({
    projectId: "restore-project",
    stateDir: root,
    fileKey: "file-key",
    rootNodeId: "2:0",
    figmaToken: "figma-token",
    fetchImpl: createFetchMock([
      createFileResponse("Original title"),
      createFileResponse("Restored title"),
    ]),
    aiClients: { openai: ai },
    pluginClient: plugin,
    defaultModelProfile: "fast",
  });

  const result = await clone.handlePrompt("Update the title", [], { modelProfile: "fast" });
  assert.ok(result.checkpoint);

  const projectDir = path.join(root, "figma-make-clone", "restore-project");
  const conversationPath = path.join(projectDir, "ai_chat.json");
  const memoryPath = path.join(projectDir, "project-memory.md");
  const originalConversation = fs.readFileSync(conversationPath, "utf8");
  const originalMemory = readTextFileOrNull(memoryPath);

  fs.writeFileSync(
    conversationPath,
    JSON.stringify({ version: 1, cumulativeTokenCount: 0, messages: [], summaryCache: {} }, null, 2),
    "utf8",
  );
  fs.writeFileSync(memoryPath, "# Overwritten memory\n", "utf8");

  await clone.restoreCheckpoint(result.checkpoint!.id);

  assert.equal(plugin.restoreVersionCalls.at(-1), result.checkpoint?.figmaVersionId);
  assert.equal(fs.readFileSync(conversationPath, "utf8"), originalConversation);
  assert.equal(readTextFileOrNull(memoryPath), originalMemory);
});

test("handlePrompt rolls back to the safety version when plugin execution fails", async () => {
  const root = tempDir("mymake-figma-rollback-");
  const ai = new MockDesignModelClient([
    [
      "Try the update again.",
      "```json",
      JSON.stringify(
        [
          {
            action: "modify",
            nodeId: "2:1",
            updates: {
              type: "TEXT",
              content: "Attempted title",
            },
          },
        ],
        null,
        2,
      ),
      "```",
    ].join("\n"),
    [
      "Try once more with the same safe change.",
      "```json",
      JSON.stringify(
        [
          {
            action: "modify",
            nodeId: "2:1",
            updates: {
              type: "TEXT",
              content: "Final title",
            },
          },
        ],
        null,
        2,
      ),
      "```",
    ].join("\n"),
  ]);
  const plugin = new MockPluginClient([
    { success: false, nodeIds: {}, error: "Plugin failed." },
    { success: true, nodeIds: { title: "2:1" } },
  ]);
  const clone = new FigmaMakeClone({
    projectId: "rollback-project",
    stateDir: root,
    fileKey: "file-key",
    rootNodeId: "2:0",
    figmaToken: "figma-token",
    fetchImpl: createFetchMock([
      createFileResponse("Original title"),
      createFileResponse("Final title"),
    ]),
    aiClients: { openai: ai },
    pluginClient: plugin,
    defaultModelProfile: "fast",
  });

  const result = await clone.handlePrompt("Update the title", [], {
    modelProfile: "fast",
    maxRetries: 2,
  });

  assert.equal(result.success, true);
  assert.equal(plugin.restoreVersionCalls.includes("version-1"), true);
});
