import fs from "node:fs/promises";
import path from "node:path";

import {
  ContextWindowManager,
  ConversationStore,
  TokenCounter,
  type ConversationMessageRecord,
} from "@/lib/server/conversation-history";
import { GuidelineRouter, GuidelineStore } from "@/lib/server/guidelines";
import {
  MYMAKE_DIR,
  type ContextGraphResult,
} from "@/lib/server/project-intelligence";
import type {
  ConversationTurnRecord,
  MakeKitRecord,
  SelectionTarget,
} from "@/lib/types";

const PROJECT_MEMORY_FILE = "project-memory.md";
const CONVERSATION_FILE = "ai_chat.json";

export interface ManagedAiContext {
  guidelinesText: string;
  projectMemoryText: string;
  conversationHistoryText: string;
  currentStateText: string;
}

interface BuildManagedAiContextParams {
  projectDir: string;
  projectName: string;
  prompt: string;
  route: string;
  selectionTarget: SelectionTarget | null;
  contextGraph: ContextGraphResult;
  kits: MakeKitRecord[];
  recentTurns: ConversationTurnRecord[];
  knowledge: {
    projectBrief: string;
    designRules: string;
    brandKit: {
      palette: string[];
      fonts: string[];
      primitives: string[];
      tokens: string[];
      typographyScale: string[];
    };
    componentIndex: {
      components: Array<{
        name: string;
        filePath: string;
        route: string | null;
        kind: "route" | "component" | "style" | "template";
        keywords: string[];
      }>;
    };
    editMemory: {
      successfulEdits: Array<{
        prompt: string;
        summary: string;
        editMode: string;
        target: string | null;
        changedFiles: string[];
        createdAt: string;
      }>;
      keepRules: string[];
      avoidRules: string[];
      preferredPatterns: string[];
    };
  };
}

export async function buildManagedAiContext(
  params: BuildManagedAiContextParams,
): Promise<ManagedAiContext> {
  const tokenCounter = new TokenCounter();
  const guidelineRoot = path.join(params.projectDir, MYMAKE_DIR, "guidelines");
  const store = new GuidelineStore({ rootDir: guidelineRoot });
  await syncGuidelineFiles({
    store,
    projectName: params.projectName,
    knowledge: params.knowledge,
    kits: params.kits,
  });

  const router = new GuidelineRouter(store);
  const guidelinesText = await router.loadForPrompt(params.prompt);

  const conversationFilePath = path.join(params.projectDir, MYMAKE_DIR, CONVERSATION_FILE);
  const conversationStore = new ConversationStore(conversationFilePath, tokenCounter);
  await syncConversationStore({
    store: conversationStore,
    turns: params.recentTurns,
    projectBrief: params.knowledge.projectBrief,
    tokenCounter,
  });

  const windowManager = new ContextWindowManager(conversationStore, tokenCounter);
  const conversationWindow = await windowManager.getWindow();
  const conversationHistoryText = formatConversationWindow(conversationWindow.messages);

  const projectMemoryPath = path.join(params.projectDir, MYMAKE_DIR, PROJECT_MEMORY_FILE);
  const projectMemoryText = await syncProjectMemoryFile({
    filePath: projectMemoryPath,
    route: params.route,
    selectionTarget: params.selectionTarget,
    contextGraph: params.contextGraph,
    knowledge: params.knowledge,
    recentTurns: params.recentTurns,
  });

  const currentStateText = buildCurrentStateText({
    route: params.route,
    selectionTarget: params.selectionTarget,
    contextGraph: params.contextGraph,
    knowledge: params.knowledge,
  });

  return {
    guidelinesText,
    projectMemoryText,
    conversationHistoryText,
    currentStateText,
  };
}

async function syncGuidelineFiles(params: {
  store: GuidelineStore;
  projectName: string;
  knowledge: BuildManagedAiContextParams["knowledge"];
  kits: MakeKitRecord[];
}): Promise<void> {
  const enabledKits = params.kits.filter((kit) => kit.enabled).sort((a, b) => b.priority - a.priority);
  const componentDocs = params.knowledge.componentIndex.components
    .filter((component) => component.kind === "component" || component.kind === "route")
    .slice(0, 80);

  params.store.addGuideline(
    "Guidelines.md",
    [
      "# Guidelines",
      "",
      "IMPORTANT: Read this routing file first before using any other guideline file.",
      "IMPORTANT: Preserve existing component wiring and route structure unless the prompt explicitly requests a refactor.",
      "IMPORTANT: Prefer existing tokens, CSS variables, and documented primitives before inventing new UI patterns.",
      "",
      `Project: ${params.projectName}`,
      "",
      "Routing",
      "- Read overview-components.md before editing reusable UI.",
      "- Read overview-tokens.md before changing color, spacing, density, or typography.",
      "- Load a matching component guideline from components/ before editing or creating that component.",
      "",
      "Active kit hints",
      ...(enabledKits.length
        ? enabledKits.slice(0, 6).map((kit) => `- ${kit.name}: ${kit.summary}`)
        : ["- No explicit kits are enabled yet. Default to the project brief and design rules."]),
      "",
      "Locked rules",
      ...extractSectionBullets(params.knowledge.designRules, "Locked rules"),
      "",
      "Soft rules",
      ...extractSectionBullets(params.knowledge.designRules, "Soft rules"),
      "",
      "Files",
      "- overview-components.md",
      "- overview-tokens.md",
      ...componentDocs.map((component) => `- components/${slugify(component.name)}.md`),
      "- design-tokens/colors.md",
      "- design-tokens/typography.md",
      "- design-tokens/spacing.md",
    ].join("\n"),
  );

  params.store.addGuideline(
    "overview-components.md",
    [
      "# Components Overview",
      "",
      "Use this file to discover which project files and UI primitives exist before editing.",
      "",
      ...componentDocs.map((component) =>
        `- ${component.name} (${component.kind}) — file: ${component.filePath}${
          component.route ? `, route: ${component.route}` : ""
        }`,
      ),
    ].join("\n"),
  );

  params.store.addGuideline(
    "overview-tokens.md",
    [
      "# Tokens Overview",
      "",
      "Use this file before making palette, type, spacing, density, or surface changes.",
      "",
      `Palette: ${params.knowledge.brandKit.palette.join(", ") || "Not detected"}`,
      `Fonts: ${params.knowledge.brandKit.fonts.join(", ") || "Not detected"}`,
      `Primitives: ${params.knowledge.brandKit.primitives.join(", ") || "Not detected"}`,
      `CSS variables: ${params.knowledge.brandKit.tokens.join(", ") || "Not detected"}`,
      `Typography scale: ${params.knowledge.brandKit.typographyScale.join(", ") || "Not detected"}`,
    ].join("\n"),
  );

  params.store.addGuideline(
    "design-tokens/colors.md",
    [
      "# Colors",
      "",
      "Prefer these existing palette values and only add new colors when the prompt explicitly asks for a broader redesign.",
      "",
      ...params.knowledge.brandKit.palette.map((color) => `- ${color}`),
      ...params.knowledge.brandKit.tokens.map((token) => `- ${token}`),
      ...(params.knowledge.brandKit.palette.length ? [] : ["- No palette extracted yet"]),
    ].join("\n"),
  );

  params.store.addGuideline(
    "design-tokens/typography.md",
    [
      "# Typography",
      "",
      "Reuse the existing typography feel before introducing new font stacks or scales.",
      "",
      ...params.knowledge.brandKit.fonts.map((font) => `- ${font}`),
      ...params.knowledge.brandKit.typographyScale.map((value) => `- ${value}`),
      ...(params.knowledge.brandKit.fonts.length ? [] : ["- No project fonts extracted yet"]),
    ].join("\n"),
  );

  params.store.addGuideline(
    "design-tokens/spacing.md",
    [
      "# Spacing",
      "",
      "Keep spacing rhythm dense, legible, and consistent. Avoid adding empty margins or oversized padding unless requested.",
      "",
      ...extractSectionBullets(params.knowledge.designRules, "Soft rules"),
    ].join("\n"),
  );

  for (const component of componentDocs) {
    params.store.addGuideline(
      `components/${slugify(component.name)}.md`,
      [
        `# ${component.name}`,
        "",
        `File: ${component.filePath}`,
        `Kind: ${component.kind}`,
        ...(component.route ? [`Route: ${component.route}`] : []),
        "",
        "Usage guidance",
        "- Preserve the existing structure and semantics before broadening scope.",
        "- Prefer editing this component directly when the request targets it by name or content.",
        component.keywords.length
          ? `- Related terms: ${component.keywords.join(", ")}`
          : "- No additional keywords were detected.",
      ].join("\n"),
    );
  }
}

async function syncConversationStore(params: {
  store: ConversationStore;
  turns: ConversationTurnRecord[];
  projectBrief: string;
  tokenCounter: TokenCounter;
}): Promise<void> {
  const existing = await params.store.exportState();
  const messages: ConversationMessageRecord[] = [
    {
      role: "user",
      content: params.projectBrief,
      timestamp: existing.messages[0]?.timestamp ?? new Date().toISOString(),
      designStateHash: null,
      tokensUsed: params.tokenCounter.countMessage({
        role: "user",
        content: params.projectBrief,
      }),
    },
    ...params.turns
      .filter(
        (turn) =>
          (turn.kind === "user" && turn.prompt) ||
          (turn.kind === "assistant" && turn.summary),
      )
      .map((turn) => {
        const role = turn.kind === "assistant" ? "assistant" : "user";
        const content = role === "assistant" ? turn.summary || "" : turn.prompt || "";
        return {
          role,
          content,
          timestamp: turn.createdAt,
          designStateHash: turn.revisionId,
          tokensUsed: params.tokenCounter.countMessage({
            role,
            content,
          }),
        } satisfies ConversationMessageRecord;
      }),
  ];

  await params.store.replaceState({
    version: 1,
    cumulativeTokenCount: messages.reduce((sum, message) => sum + message.tokensUsed, 0),
    messages,
    summaryCache: existing.summaryCache,
  });
}

async function syncProjectMemoryFile(params: {
  filePath: string;
  route: string;
  selectionTarget: SelectionTarget | null;
  contextGraph: ContextGraphResult;
  knowledge: BuildManagedAiContextParams["knowledge"];
  recentTurns: ConversationTurnRecord[];
}): Promise<string> {
  await fs.mkdir(path.dirname(params.filePath), { recursive: true });

  const recentAppliedTurns = params.recentTurns
    .filter((turn) => turn.kind === "assistant" && turn.status === "applied" && turn.summary)
    .slice(-8);

  const content = [
    "# Project Memory",
    "",
    "## Current route",
    "",
    `- ${params.route}`,
    params.selectionTarget ? `- Focus target: ${params.selectionTarget.label}` : "- Focus target: none",
    "",
    "## Stable design decisions",
    "",
    ...params.knowledge.editMemory.keepRules.map((rule) => `- ${rule}`),
    ...(params.knowledge.editMemory.keepRules.length ? [] : ["- Preserve the existing visual language unless the prompt broadens scope."]),
    "",
    "## Avoid",
    "",
    ...params.knowledge.editMemory.avoidRules.map((rule) => `- ${rule}`),
    ...(params.knowledge.editMemory.avoidRules.length ? [] : ["- Avoid breaking module wiring or introducing excess empty space."]),
    "",
    "## Preferred patterns",
    "",
    ...params.knowledge.editMemory.preferredPatterns.map((pattern) => `- ${pattern}`),
    ...(params.knowledge.editMemory.preferredPatterns.length ? [] : ["- Prefer concise, reversible edits grounded in the current component structure."]),
    "",
    "## Recent applied edits",
    "",
    ...recentAppliedTurns.map((turn) => `- ${turn.summary}`),
    ...(recentAppliedTurns.length ? [] : ["- No applied edits recorded yet."]),
    "",
    "## Current state summary",
    "",
    `- Primary target: ${params.contextGraph.primaryTarget || params.route}`,
    `- Context files in play: ${params.contextGraph.contextFiles.map((file) => file.path).slice(0, 8).join(", ") || "none"}`,
    `- Active palette: ${params.knowledge.brandKit.palette.slice(0, 6).join(", ") || "not extracted"}`,
  ].join("\n");

  await fs.writeFile(params.filePath, content.trimEnd() + "\n", "utf8");
  return content;
}

function buildCurrentStateText(params: {
  route: string;
  selectionTarget: SelectionTarget | null;
  contextGraph: ContextGraphResult;
  knowledge: BuildManagedAiContextParams["knowledge"];
}): string {
  return [
    `Route: ${params.route}`,
    `Primary target: ${params.selectionTarget?.label || params.contextGraph.primaryTarget || "None selected"}`,
    `Target summary: ${params.selectionTarget?.summary || "No selected element context."}`,
    `Likely source file: ${params.selectionTarget?.sourceFilePath || "Not resolved"}`,
    `Brand palette: ${params.knowledge.brandKit.palette.slice(0, 8).join(", ") || "Not extracted"}`,
    `Fonts: ${params.knowledge.brandKit.fonts.slice(0, 5).join(", ") || "Not extracted"}`,
    "Relevant source files:",
    ...params.contextGraph.contextFiles
      .slice(0, 8)
      .map((file) => `- ${file.path} — ${file.reason}`),
  ].join("\n");
}

function formatConversationWindow(messages: ConversationMessageRecord[]): string {
  return messages
    .map((message) => {
      const label =
        message.role === "assistant"
          ? "Assistant"
          : message.role === "system"
            ? "System"
            : "User";
      return `[${label}] ${message.content}`;
    })
    .join("\n\n");
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "component";
}

function extractSectionBullets(markdown: string, heading: string): string[] {
  const lines = markdown.split("\n");
  const target = heading.trim().toLowerCase();
  const collected: string[] = [];
  let active = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) {
      active = trimmed.replace(/^#+\s*/, "").trim().toLowerCase() === target;
      continue;
    }

    if (!active) {
      continue;
    }

    if (trimmed.startsWith("-")) {
      collected.push(trimmed);
      continue;
    }

    if (trimmed && !trimmed.startsWith("-")) {
      break;
    }
  }

  return collected.slice(0, 8);
}

export function getProjectMemoryPath(projectDir: string): string {
  return path.join(projectDir, MYMAKE_DIR, PROJECT_MEMORY_FILE);
}
