import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import type {
  GetFileResponse,
  GetLocalVariablesResponse,
} from "@figma/rest-api-spec/dist/api_types";

import { GuidelineRouter, GuidelineStore } from "@/lib/server/guidelines";
import {
  ContextWindowManager,
  ConversationStore,
  DesignStateTracker,
  PromptAssembler,
  TokenCounter,
  type ConversationMessageRecord,
  type ConversationSummarizer,
  type ProjectMemoryUpdater,
} from "@/lib/server/conversation-history";

class MockSummarizer implements ConversationSummarizer {
  calls = 0;

  async summarize(input: { prompt: string; messages: ConversationMessageRecord[] }): Promise<string> {
    this.calls += 1;
    return [
      input.prompt,
      ...input.messages.map((message, index) => `- ${index + 1}. ${message.content.slice(0, 60)}`),
    ].join("\n");
  }
}

class MockMemoryUpdater implements ProjectMemoryUpdater {
  calls = 0;

  async updateProjectMemory(): Promise<string> {
    this.calls += 1;
    return "# Project memory\n\n- Refreshed from snapshots.";
  }
}

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createMinimalFileResponse(text: string): GetFileResponse {
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
              name: "Root frame",
              type: "FRAME",
              visible: true,
              locked: false,
              scrollBehavior: "SCROLLS",
              absoluteBoundingBox: { x: 0, y: 0, width: 320, height: 160 },
              absoluteRenderBounds: { x: 0, y: 0, width: 320, height: 160 },
              blendMode: "PASS_THROUGH",
              opacity: 1,
              clipsContent: false,
              layoutMode: "VERTICAL",
              primaryAxisAlignItems: "MIN",
              counterAxisAlignItems: "MIN",
              paddingTop: 16,
              paddingRight: 16,
              paddingBottom: 16,
              paddingLeft: 16,
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
                  absoluteBoundingBox: { x: 16, y: 16, width: 220, height: 36 },
                  absoluteRenderBounds: { x: 16, y: 16, width: 220, height: 36 },
                  blendMode: "NORMAL",
                  opacity: 1,
                  fills: [],
                  effects: [],
                  exportSettings: [],
                  characters: text,
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
    name: "Conversation test file",
    role: "owner",
    lastModified: "2026-04-13T00:00:00.000Z",
    thumbnailUrl: "",
    version: "1",
    editorType: "figma",
  } as unknown as GetFileResponse;
}

test("context window manager summarizes the middle of long conversations and reuses cache", async () => {
  const rootDir = tempDir("mymake-conversation-");
  const store = new ConversationStore(path.join(rootDir, "ai_chat.json"));
  const summarizer = new MockSummarizer();
  const tokenCounter = new TokenCounter();

  await store.addMessage({
    role: "user",
    content: "Original project brief: create a finance dashboard with charts and cards.",
    designStateHash: "hash-0",
  });

  for (let index = 1; index <= 18; index += 1) {
    await store.addMessage({
      role: index % 2 === 0 ? "assistant" : "user",
      content: `Message ${index} ${"detail ".repeat(60)}${index}`,
      designStateHash: `hash-${index}`,
    });
  }

  const manager = new ContextWindowManager(store, tokenCounter, {
    budgets: {
      conversationBudget: 350,
    },
    summarizer,
  });

  const firstWindow = await manager.getWindow();
  assert.equal(firstWindow.summaryUsed, true);
  assert.equal(summarizer.calls, 1);
  assert.equal(firstWindow.messages[0]?.content.includes("Original project brief"), true);
  assert.equal(firstWindow.messages.at(-1)?.content.includes("Message 18"), true);
  assert.ok(firstWindow.messages.some((message) => message.content.startsWith("Conversation summary")));

  const secondWindow = await manager.getWindow();
  assert.equal(secondWindow.summaryUsed, true);
  assert.equal(summarizer.calls, 1);
  assert.equal(secondWindow.summaryCacheKey, firstWindow.summaryCacheKey);
});

test("design state tracker refreshes project memory every configured number of edits", async () => {
  const rootDir = tempDir("mymake-state-");
  const memoryUpdater = new MockMemoryUpdater();
  const tracker = new DesignStateTracker({
    snapshotsFilePath: path.join(rootDir, "design-state-history.json"),
    projectMemoryFilePath: path.join(rootDir, "project-memory.md"),
    memoryUpdater,
    memoryRefreshEvery: 10,
  });

  for (let index = 1; index <= 10; index += 1) {
    await tracker.captureSnapshot({
      file: createMinimalFileResponse(`State ${index}`),
      targetNodeId: "2:0",
    });
  }

  const currentState = await tracker.getCurrentState();
  const diff = await tracker.diffBetween(9, 10);
  const memory = await tracker.readProjectMemory();

  assert.ok(currentState);
  assert.ok(diff);
  assert.ok(diff?.added.some((line) => line.includes("State 10")));
  assert.equal(memoryUpdater.calls, 1);
  assert.match(memory ?? "", /Project memory/);
});

test("prompt assembler orders system prompt, memory, state, conversation, and user message", async () => {
  const rootDir = tempDir("mymake-assembler-");
  const guidelinesRoot = path.join(rootDir, "guidelines");
  const store = new GuidelineStore({ rootDir: guidelinesRoot });
  store.addGuideline("Guidelines.md", "# Guidelines\n\nIMPORTANT: Use the design system.");
  store.addGuideline("overview-components.md", "# Components overview\n\n- button");
  store.addGuideline("overview-tokens.md", "# Tokens overview\n\n- color/primary: #3b82f6");
  store.addGuideline("components/button.md", "# Button\n\nUse for CTAs.");

  const router = new GuidelineRouter(store, { tokenBudget: 800 });
  const conversationStore = new ConversationStore(path.join(rootDir, "ai_chat.json"));
  await conversationStore.addMessage({
    role: "user",
    content: "Initial project description: modern SaaS landing page.",
    designStateHash: "hash-initial",
  });
  await conversationStore.addMessage({
    role: "assistant",
    content: "Created a hero section and CTA.",
    designStateHash: "hash-hero",
  });

  const tracker = new DesignStateTracker({
    snapshotsFilePath: path.join(rootDir, "design-state-history.json"),
    projectMemoryFilePath: path.join(rootDir, "project-memory.md"),
    memoryRefreshEvery: 10,
  });
  await tracker.captureSnapshot({
    file: createMinimalFileResponse("Landing page hero"),
    targetNodeId: "2:0",
  });
  await fs.promises.writeFile(
    path.join(rootDir, "project-memory.md"),
    "# Project memory\n\n- Hero exists.\n- CTA is primary blue.\n",
    "utf8",
  );

  const windowManager = new ContextWindowManager(conversationStore, new TokenCounter(), {
    budgets: { conversationBudget: 2000 },
  });
  const assembler = new PromptAssembler(
    store,
    router,
    windowManager,
    tracker,
    new TokenCounter(),
  );
  assembler.setPendingAttachments(["hero-reference.png"]);

  const prompt = await assembler.assemblePrompt("Refine the button spacing and color.");

  assert.equal(prompt.messages[0]?.role, "system");
  assert.match(prompt.messages[0]?.content ?? "", /design system-aware code generator/i);
  assert.match(prompt.messages[1]?.content ?? "", /Project memory/);
  assert.match(prompt.messages[2]?.content ?? "", /Current design state/);
  assert.equal(prompt.messages.at(-1)?.role, "user");
  assert.match(prompt.messages.at(-1)?.content ?? "", /Attachments:/);
  assert.ok(prompt.tokenCount > 0);
});
