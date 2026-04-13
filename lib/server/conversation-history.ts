import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { get_encoding, type Tiktoken, type TiktokenEncoding } from "tiktoken";

import {
  serializeFigmaDesignContext,
  type FileResponse,
} from "@/lib/figma/design-context-serializer";
import {
  buildGuidelineSystemPrompt,
  type GuidelineRouter,
  type GuidelineStore,
} from "@/lib/server/guidelines";

const DEFAULT_ENCODING: TiktokenEncoding = "o200k_base";
const DEFAULT_MEMORY_PROMPT =
  "Update the project memory file with a summary of recent changes, current design state, known issues, and design decisions made.";
const DEFAULT_SUMMARY_PROMPT =
  "Summarize the following conversation history into a concise list of all design decisions made, components created, and current state of the project. Focus on WHAT was changed, not the back-and-forth discussion.";
const TEXT_DECODER = new TextDecoder();

export interface ConversationHistoryBudgets {
  targetContextTokens: number;
  systemPromptBudget: number;
  guidelinesBudget: number;
  conversationBudget: number;
  currentStateBudget: number;
}

export interface ConversationMessageRecord {
  role: "system" | "user" | "assistant";
  content: string;
  timestamp: string;
  designStateHash: string | null;
  tokensUsed: number;
}

export interface ConversationSummaryCacheEntry {
  cacheKey: string;
  content: string;
  tokensUsed: number;
  sourceMessageCount: number;
  createdAt: string;
}

export interface ConversationStoreState {
  version: 1;
  cumulativeTokenCount: number;
  messages: ConversationMessageRecord[];
  summaryCache: Record<string, ConversationSummaryCacheEntry>;
}

export interface DesignStateSnapshot {
  id: string;
  revisionNumber: number;
  timestamp: string;
  targetNodeId: string;
  designStateHash: string;
  sparse: string;
  semantic: string;
  variables: Record<string, string>;
  tokenEstimate: number;
  warnings: string[];
}

export interface DesignStateDiff {
  fromHash: string;
  toHash: string;
  added: string[];
  removed: string[];
}

export interface ProjectMemoryUpdateInput {
  prompt: string;
  existingMemory: string | null;
  recentSnapshots: DesignStateSnapshot[];
  currentState: DesignStateSnapshot | null;
  diffs: DesignStateDiff[];
}

export interface ConversationSummaryInput {
  prompt: string;
  messages: ConversationMessageRecord[];
}

export interface PromptMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface PromptAssemblyResult {
  messages: PromptMessage[];
  tokenCount: number;
}

export interface ContextWindowResult {
  messages: ConversationMessageRecord[];
  tokenCount: number;
  summaryUsed: boolean;
  summaryCacheKey: string | null;
}

export interface ConversationSummarizer {
  summarize(input: ConversationSummaryInput): Promise<string>;
}

export interface ProjectMemoryUpdater {
  updateProjectMemory(input: ProjectMemoryUpdateInput): Promise<string>;
}

export interface DesignStateTrackerOptions {
  snapshotsFilePath: string;
  projectMemoryFilePath: string;
  memoryUpdater?: ProjectMemoryUpdater;
  memoryRefreshEvery?: number;
}

export interface ContextWindowManagerOptions {
  budgets?: Partial<ConversationHistoryBudgets>;
  summarizer?: ConversationSummarizer;
  keepRecentMessages?: number;
}

export interface PromptAssemblerOptions {
  fixedInstructions?: string;
  currentStateBudget?: number;
}

export const DEFAULT_CONTEXT_BUDGETS: ConversationHistoryBudgets = {
  targetContextTokens: 32000,
  systemPromptBudget: 8000,
  guidelinesBudget: 4000,
  conversationBudget: 16000,
  currentStateBudget: 4000,
};

export class TokenCounter {
  private readonly encoder: Tiktoken;

  constructor(encoding: TiktokenEncoding = DEFAULT_ENCODING) {
    this.encoder = get_encoding(encoding);
  }

  countText(text: string): number {
    if (!text) {
      return 0;
    }
    return this.encoder.encode(text).length;
  }

  countMessage(message: { role: string; content: string }): number {
    return this.countText(`${message.role}\n${message.content}`);
  }

  countMessages(messages: Array<{ role: string; content: string }>): number {
    return messages.reduce((total, message) => total + this.countMessage(message), 0);
  }

  truncateText(text: string, maxTokens: number): string {
    if (maxTokens <= 0 || !text) {
      return "";
    }

    const tokens = this.encoder.encode(text);
    if (tokens.length <= maxTokens) {
      return text;
    }

    const truncated = TEXT_DECODER.decode(this.encoder.decode(tokens.slice(0, maxTokens))).trimEnd();
    return `${truncated}\n[truncated]`;
  }
}

export class ConversationStore {
  private readonly filePath: string;
  private readonly tokenCounter: TokenCounter;
  private state: ConversationStoreState | null = null;

  constructor(filePath: string, tokenCounter = new TokenCounter()) {
    this.filePath = filePath;
    this.tokenCounter = tokenCounter;
  }

  async getMessages(): Promise<ConversationMessageRecord[]> {
    const state = await this.loadState();
    return [...state.messages];
  }

  async exportState(): Promise<ConversationStoreState> {
    const state = await this.loadState();
    return {
      version: state.version,
      cumulativeTokenCount: state.cumulativeTokenCount,
      messages: state.messages.map((message) => ({ ...message })),
      summaryCache: { ...state.summaryCache },
    };
  }

  async replaceState(state: ConversationStoreState): Promise<void> {
    await this.saveState({
      version: 1,
      cumulativeTokenCount: state.cumulativeTokenCount ?? 0,
      messages: (state.messages ?? []).map((message) => ({ ...message })),
      summaryCache: { ...(state.summaryCache ?? {}) },
    });
  }

  async addMessage(input: {
    role: ConversationMessageRecord["role"];
    content: string;
    designStateHash: string | null;
    timestamp?: string;
  }): Promise<ConversationMessageRecord> {
    const state = await this.loadState();
    const message: ConversationMessageRecord = {
      role: input.role,
      content: input.content,
      timestamp: input.timestamp ?? new Date().toISOString(),
      designStateHash: input.designStateHash,
      tokensUsed: this.tokenCounter.countMessage({
        role: input.role,
        content: input.content,
      }),
    };

    state.messages.push(message);
    state.cumulativeTokenCount += message.tokensUsed;
    await this.saveState(state);
    return message;
  }

  async getCumulativeTokenCount(): Promise<number> {
    const state = await this.loadState();
    return state.cumulativeTokenCount;
  }

  async getSummaryCache(cacheKey: string): Promise<ConversationSummaryCacheEntry | null> {
    const state = await this.loadState();
    return state.summaryCache[cacheKey] ?? null;
  }

  async setSummaryCache(entry: ConversationSummaryCacheEntry): Promise<void> {
    const state = await this.loadState();
    state.summaryCache[entry.cacheKey] = entry;
    await this.saveState(state);
  }

  private async loadState(): Promise<ConversationStoreState> {
    if (this.state) {
      return this.state;
    }

    await fs.mkdir(path.dirname(this.filePath), { recursive: true });

    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<ConversationStoreState>;
      this.state = {
        version: 1,
        cumulativeTokenCount: parsed.cumulativeTokenCount ?? 0,
        messages: parsed.messages ?? [],
        summaryCache: parsed.summaryCache ?? {},
      };
    } catch {
      this.state = {
        version: 1,
        cumulativeTokenCount: 0,
        messages: [],
        summaryCache: {},
      };
      await this.saveState(this.state);
    }

    return this.state;
  }

  private async saveState(state: ConversationStoreState): Promise<void> {
    this.state = state;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(state, null, 2), "utf8");
  }
}

export class HeuristicConversationSummarizer implements ConversationSummarizer {
  async summarize(input: ConversationSummaryInput): Promise<string> {
    const bullets = input.messages
      .map((message) => message.content.trim())
      .filter(Boolean)
      .map((content) => content.replace(/\s+/g, " "))
      .slice(0, 18)
      .map((content) => `- ${content.slice(0, 220)}`);

    return [
      "Conversation summary",
      "",
      ...bullets,
    ].join("\n");
  }
}

export class HeuristicProjectMemoryUpdater implements ProjectMemoryUpdater {
  async updateProjectMemory(input: ProjectMemoryUpdateInput): Promise<string> {
    const recentHashes = input.recentSnapshots
      .slice(-10)
      .map((snapshot) => `- Revision ${snapshot.revisionNumber}: ${snapshot.designStateHash.slice(0, 12)}`)
      .join("\n");
    const knownIssues = input.diffs
      .slice(-5)
      .flatMap((diff) => diff.removed.slice(0, 2))
      .map((entry) => `- ${entry}`)
      .slice(0, 6)
      .join("\n");

    return [
      "# Project memory",
      "",
      "## Current design state",
      "",
      input.currentState?.semantic
        ? truncateByChars(input.currentState.semantic, 2400)
        : "No snapshots captured yet.",
      "",
      "## Recent changes",
      "",
      recentHashes || "- No recent changes recorded.",
      "",
      "## Known issues",
      "",
      knownIssues || "- None documented.",
      "",
      "## Design decisions",
      "",
      input.existingMemory
        ? truncateByChars(input.existingMemory, 1200)
        : "- No prior memory recorded.",
    ].join("\n");
  }
}

export class ContextWindowManager {
  private readonly store: ConversationStore;
  private readonly tokenCounter: TokenCounter;
  private readonly budgets: ConversationHistoryBudgets;
  private readonly summarizer: ConversationSummarizer;
  private readonly keepRecentMessages: number;

  constructor(
    store: ConversationStore,
    tokenCounter = new TokenCounter(),
    options: ContextWindowManagerOptions = {},
  ) {
    this.store = store;
    this.tokenCounter = tokenCounter;
    this.budgets = {
      ...DEFAULT_CONTEXT_BUDGETS,
      ...options.budgets,
    };
    this.summarizer = options.summarizer ?? new HeuristicConversationSummarizer();
    this.keepRecentMessages = options.keepRecentMessages ?? 5;
  }

  async getWindow(): Promise<ContextWindowResult> {
    const messages = await this.store.getMessages();
    const totalTokens = this.tokenCounter.countMessages(messages);
    if (totalTokens <= this.budgets.conversationBudget) {
      return {
        messages,
        tokenCount: totalTokens,
        summaryUsed: false,
        summaryCacheKey: null,
      };
    }

    if (messages.length <= 1) {
      return {
        messages,
        tokenCount: totalTokens,
        summaryUsed: false,
        summaryCacheKey: null,
      };
    }

    const firstMessage = messages[0];
    const recentMessages = messages.slice(Math.max(1, messages.length - this.keepRecentMessages));
    const middleMessages = messages.slice(1, Math.max(1, messages.length - this.keepRecentMessages));

    const summaryCacheKey = buildSummaryCacheKey(middleMessages);
    const cached = await this.store.getSummaryCache(summaryCacheKey);
    const summaryContent =
      cached?.content ??
      (await this.summarizer.summarize({
        prompt: DEFAULT_SUMMARY_PROMPT,
        messages: middleMessages,
      }));

    if (!cached) {
      await this.store.setSummaryCache({
        cacheKey: summaryCacheKey,
        content: summaryContent,
        tokensUsed: this.tokenCounter.countMessage({ role: "system", content: summaryContent }),
        sourceMessageCount: middleMessages.length,
        createdAt: new Date().toISOString(),
      });
    }

    const summaryMessage: ConversationMessageRecord = {
      role: "system",
      content: `Conversation summary\n\n${summaryContent}`,
      timestamp: middleMessages.at(-1)?.timestamp ?? new Date().toISOString(),
      designStateHash: middleMessages.at(-1)?.designStateHash ?? null,
      tokensUsed: this.tokenCounter.countMessage({
        role: "system",
        content: `Conversation summary\n\n${summaryContent}`,
      }),
    };

    const managed = this.fitMessagesToBudget([
      firstMessage,
      summaryMessage,
      ...recentMessages,
    ]);

    return {
      messages: managed,
      tokenCount: this.tokenCounter.countMessages(managed),
      summaryUsed: true,
      summaryCacheKey,
    };
  }

  private fitMessagesToBudget(messages: ConversationMessageRecord[]): ConversationMessageRecord[] {
    const budget = this.budgets.conversationBudget;
    const result = messages.map((message) => ({ ...message }));
    let currentTokens = this.tokenCounter.countMessages(result);

    if (currentTokens <= budget) {
      return result;
    }

    const summaryIndex = result.findIndex(
      (message) => message.role === "system" && message.content.startsWith("Conversation summary"),
    );
    if (summaryIndex >= 0) {
      const remainingWithoutSummary = this.tokenCounter.countMessages(
        result.filter((_, index) => index !== summaryIndex),
      );
      const availableForSummary = Math.max(64, budget - remainingWithoutSummary);
      result[summaryIndex] = {
        ...result[summaryIndex],
        content: this.tokenCounter.truncateText(result[summaryIndex].content, availableForSummary),
      };
    }

    currentTokens = this.tokenCounter.countMessages(result);
    if (currentTokens <= budget) {
      return result;
    }

    const minimumPerMessage = 48;
    let guard = 0;
    while (currentTokens > budget && guard < 100) {
      guard += 1;
      let candidateIndex = -1;
      let candidateTokens = -1;
      const preferRecentIndexes = result
        .map((_, index) => index)
        .filter((index) => index > 0 && index !== summaryIndex);
      const fallbackIndexes = summaryIndex >= 0 ? [summaryIndex] : [];
      for (const index of [...preferRecentIndexes, ...fallbackIndexes]) {
        const tokenCount = this.tokenCounter.countMessage(result[index]);
        if (tokenCount > candidateTokens && tokenCount > minimumPerMessage) {
          candidateIndex = index;
          candidateTokens = tokenCount;
        }
      }

      if (candidateIndex < 0) {
        break;
      }

      const nextTarget = Math.max(minimumPerMessage, Math.floor(candidateTokens * 0.75));
      result[candidateIndex] = {
        ...result[candidateIndex],
        content: this.tokenCounter.truncateText(result[candidateIndex].content, nextTarget),
      };
      currentTokens = this.tokenCounter.countMessages(result);
    }

    return result;
  }
}

export class DesignStateTracker {
  private readonly snapshotsFilePath: string;
  private readonly projectMemoryFilePath: string;
  private readonly memoryUpdater: ProjectMemoryUpdater;
  private readonly memoryRefreshEvery: number;

  constructor(options: DesignStateTrackerOptions) {
    this.snapshotsFilePath = options.snapshotsFilePath;
    this.projectMemoryFilePath = options.projectMemoryFilePath;
    this.memoryUpdater = options.memoryUpdater ?? new HeuristicProjectMemoryUpdater();
    this.memoryRefreshEvery = options.memoryRefreshEvery ?? 10;
  }

  async captureSnapshot(params: {
    file: FileResponse;
    targetNodeId: string;
  }): Promise<DesignStateSnapshot> {
    const snapshots = await this.getSnapshots();
    const serialized = serializeFigmaDesignContext(params.file, params.targetNodeId);
    const designStateHash = sha256(serialized.semantic);
    const snapshot: DesignStateSnapshot = {
      id: `snapshot-${snapshots.length + 1}`,
      revisionNumber: snapshots.length + 1,
      timestamp: new Date().toISOString(),
      targetNodeId: params.targetNodeId,
      designStateHash,
      sparse: serialized.sparse,
      semantic: serialized.semantic,
      variables: serialized.variables,
      tokenEstimate: serialized.tokenEstimate,
      warnings: serialized.warnings,
    };

    snapshots.push(snapshot);
    await this.saveSnapshots(snapshots);

    if (snapshots.length % this.memoryRefreshEvery === 0) {
      await this.refreshProjectMemory();
    }

    return snapshot;
  }

  async getSnapshots(): Promise<DesignStateSnapshot[]> {
    try {
      const raw = await fs.readFile(this.snapshotsFilePath, "utf8");
      return JSON.parse(raw) as DesignStateSnapshot[];
    } catch {
      return [];
    }
  }

  async replaceSnapshots(snapshots: DesignStateSnapshot[]): Promise<void> {
    await this.saveSnapshots(snapshots.map((snapshot) => ({ ...snapshot })));
  }

  async getCurrentState(): Promise<DesignStateSnapshot | null> {
    const snapshots = await this.getSnapshots();
    return snapshots.at(-1) ?? null;
  }

  async diffBetween(fromRevision: number, toRevision: number): Promise<DesignStateDiff | null> {
    const snapshots = await this.getSnapshots();
    const previous = snapshots.find((snapshot) => snapshot.revisionNumber === fromRevision);
    const next = snapshots.find((snapshot) => snapshot.revisionNumber === toRevision);
    if (!previous || !next) {
      return null;
    }

    return computeDesignDiff(previous, next);
  }

  async readProjectMemory(): Promise<string | null> {
    try {
      return await fs.readFile(this.projectMemoryFilePath, "utf8");
    } catch {
      return null;
    }
  }

  async writeProjectMemory(content: string | null): Promise<void> {
    await fs.mkdir(path.dirname(this.projectMemoryFilePath), { recursive: true });
    if (!content) {
      try {
        await fs.unlink(this.projectMemoryFilePath);
      } catch {
        // ignore missing memory files
      }
      return;
    }
    await fs.writeFile(this.projectMemoryFilePath, content.trimEnd() + "\n", "utf8");
  }

  async refreshProjectMemory(): Promise<string | null> {
    const snapshots = await this.getSnapshots();
    if (snapshots.length === 0) {
      return null;
    }

    const recentSnapshots = snapshots.slice(-this.memoryRefreshEvery);
    const diffs: DesignStateDiff[] = [];
    for (let index = 1; index < recentSnapshots.length; index += 1) {
      diffs.push(computeDesignDiff(recentSnapshots[index - 1], recentSnapshots[index]));
    }

    const content = await this.memoryUpdater.updateProjectMemory({
      prompt: DEFAULT_MEMORY_PROMPT,
      existingMemory: await this.readProjectMemory(),
      recentSnapshots,
      currentState: snapshots.at(-1) ?? null,
      diffs,
    });

    await this.writeProjectMemory(content);
    return content;
  }

  private async saveSnapshots(snapshots: DesignStateSnapshot[]): Promise<void> {
    await fs.mkdir(path.dirname(this.snapshotsFilePath), { recursive: true });
    await fs.writeFile(this.snapshotsFilePath, JSON.stringify(snapshots, null, 2), "utf8");
  }
}

export class PromptAssembler {
  private readonly router: GuidelineRouter;
  private readonly store: GuidelineStore;
  private readonly contextWindowManager: ContextWindowManager;
  private readonly designStateTracker: DesignStateTracker;
  private readonly tokenCounter: TokenCounter;
  private readonly fixedInstructions: string;
  private readonly currentStateBudget: number;
  private pendingAttachments: string[] = [];

  constructor(
    store: GuidelineStore,
    router: GuidelineRouter,
    contextWindowManager: ContextWindowManager,
    designStateTracker: DesignStateTracker,
    tokenCounter = new TokenCounter(),
    options: PromptAssemblerOptions = {},
  ) {
    this.store = store;
    this.router = router;
    this.contextWindowManager = contextWindowManager;
    this.designStateTracker = designStateTracker;
    this.tokenCounter = tokenCounter;
    this.fixedInstructions =
      options.fixedInstructions ??
      "You are a design-aware Figma editing assistant. Make deliberate, high-quality changes, preserve user intent, and explain only what matters.";
    this.currentStateBudget =
      options.currentStateBudget ?? DEFAULT_CONTEXT_BUDGETS.currentStateBudget;
  }

  setPendingAttachments(attachments: string[]): void {
    this.pendingAttachments = attachments.filter(Boolean);
  }

  async assemblePrompt(userMessage: string): Promise<PromptAssemblyResult> {
    const loadedGuidelines = await this.router.loadForPrompt(userMessage);
    const systemPrompt = buildGuidelineSystemPrompt({
      loadedGuidelines: [this.fixedInstructions, loadedGuidelines].filter(Boolean).join("\n\n"),
      componentList: this.store.getComponentList(),
      tokenSummary: this.store.getTokenSummaryLines(),
    });

    const projectMemory = await this.designStateTracker.readProjectMemory();
    const currentState = await this.designStateTracker.getCurrentState();
    const currentStateContent = currentState
      ? this.tokenCounter.truncateText(currentState.semantic, this.currentStateBudget)
      : "No current design state snapshot is available yet.";
    const conversation = await this.contextWindowManager.getWindow();

    const messages: PromptMessage[] = [
      { role: "system", content: systemPrompt },
      {
        role: "system",
        content: `Project memory\n\n${projectMemory ?? "No project memory file yet."}`,
      },
      {
        role: "system",
        content: `Current design state\n\n${currentStateContent}`,
      },
      ...conversation.messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      {
        role: "user",
        content: [
          userMessage,
          this.pendingAttachments.length
            ? `Attachments:\n${this.pendingAttachments.map((item) => `- ${item}`).join("\n")}`
            : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
    ];

    return {
      messages,
      tokenCount: this.tokenCounter.countMessages(messages),
    };
  }
}

function computeDesignDiff(
  previous: DesignStateSnapshot,
  next: DesignStateSnapshot,
): DesignStateDiff {
  const previousLines = normalizeDiffLines(previous.semantic);
  const nextLines = normalizeDiffLines(next.semantic);
  return {
    fromHash: previous.designStateHash,
    toHash: next.designStateHash,
    added: nextLines.filter((line) => !previousLines.includes(line)).slice(0, 50),
    removed: previousLines.filter((line) => !nextLines.includes(line)).slice(0, 50),
  };
}

function normalizeDiffLines(content: string): string[] {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function buildSummaryCacheKey(messages: ConversationMessageRecord[]): string {
  return sha256(
    JSON.stringify(
      messages.map((message) => ({
        role: message.role,
        content: message.content,
        designStateHash: message.designStateHash,
      })),
    ),
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function truncateByChars(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars).trimEnd()}\n[truncated]`;
}
