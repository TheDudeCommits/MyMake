import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type {
  GetFileResponse,
  GetLocalVariablesResponse,
} from "@figma/rest-api-spec/dist/api_types";
import Anthropic from "@anthropic-ai/sdk";
import { nanoid } from "nanoid";
import OpenAI from "openai";
import WebSocket from "ws";

import {
  AIResponseParser,
  OperationCompiler,
  OperationGraph,
  type FigmaOperation,
  type OperationValidationResult,
} from "@/lib/figma/operation-translation";
import {
  AttachmentManager,
  collectProcessedAttachmentImages,
  formatProcessedAttachmentsForPrompt,
  type AttachmentSourceInput,
  type ProcessedAttachment,
} from "@/lib/server/attachment-manager";
import {
  ContextWindowManager,
  ConversationStore,
  DesignStateTracker,
  PromptAssembler,
  TokenCounter,
  type ConversationMessageRecord,
  type ConversationSummarizer,
  type ConversationStoreState,
  type DesignStateSnapshot,
  type PromptMessage,
  type ProjectMemoryUpdateInput,
  type ProjectMemoryUpdater,
} from "@/lib/server/conversation-history";
import { GuidelineRouter, GuidelineStore } from "@/lib/server/guidelines";
import {
  serializeFigmaDesignContext,
  type FileResponse,
} from "@/lib/figma/design-context-serializer";

type ModelProvider = "openai" | "anthropic";
export type ModelProfileName = "default" | "fast" | "powerful";

export interface ModelConfig {
  provider: ModelProvider;
  model: string;
}

export interface FigmaPluginExecutionResult {
  success: boolean;
  nodeIds: Record<string, string>;
  error?: string;
}

export interface FigmaPluginBridge {
  executeCode(code: string): Promise<FigmaPluginExecutionResult>;
  createVersion(label: string): Promise<string | null>;
  restoreVersion(versionId: string): Promise<void>;
  getPreviewThumbnail(nodeId?: string): Promise<string | null>;
  disconnect?(): Promise<void>;
}

export interface Checkpoint {
  id: string;
  label: string;
  createdAt: string;
  designStateHash: string;
  figmaVersionId: string | null;
  conversationState: ConversationStoreState;
  designSnapshots: DesignStateSnapshot[];
  projectMemory: string | null;
}

export interface EditResult {
  success: boolean;
  dryRun: boolean;
  explanation: string;
  rawAiResponse: string | null;
  modelProfile: ModelProfileName;
  model: ModelConfig;
  operationsJson: string | null;
  operations: FigmaOperation[];
  compiledCode: string | null;
  validation: OperationValidationResult | null;
  execution: FigmaPluginExecutionResult | null;
  checkpoint: Checkpoint | null;
  previewThumbnail: string | null;
  tokenCount: number;
  designStateHash: string | null;
  warnings: string[];
  error?: string;
}

export interface HandlePromptOptions {
  dryRun?: boolean;
  modelProfile?: ModelProfileName;
  additionalAttachments?: AttachmentSourceInput[];
  maxRetries?: number;
  createCheckpoint?: boolean;
  checkpointLabel?: string;
}

export interface FigmaMakeCloneOptions {
  projectId: string;
  stateDir: string;
  fileKey: string;
  rootNodeId: string;
  figmaToken: string;
  initialProjectDescription?: string;
  guidelineRootDir?: string;
  pluginUrl?: string;
  pluginClient?: FigmaPluginBridge;
  fetchImpl?: typeof fetch;
  openaiApiKey?: string;
  anthropicApiKey?: string;
  aiClients?: Partial<Record<ModelProvider, DesignModelClient>>;
  defaultModelProfile?: ModelProfileName;
  systemPrompt?: string;
}

export interface DesignModelClient {
  complete(input: DesignModelInvocation & ModelInvocationOptions): Promise<string>;
}

export interface DesignModelInvocation {
  model: string;
  systemPrompt: string;
  messages: PromptMessage[];
  processedAttachments: ProcessedAttachment[];
}

interface ModelInvocationOptions {
  maxTokens?: number;
  temperature?: number;
}

interface SerializedCurrentState {
  file: FileResponse;
  localVariables: GetLocalVariablesResponse | null;
  semantic: string;
  sparse: string;
  variables: Record<string, string>;
  warnings: string[];
  designStateHash: string;
  versionId: string;
}

interface FigmaFilePayload {
  file: GetFileResponse;
  localVariables: GetLocalVariablesResponse | null;
}

const DEFAULT_STATE_SUBDIR = "figma-make-clone";
const CHECKPOINTS_FILE = "checkpoints.json";
const DEFAULT_MAX_RETRIES = 3;

export class OpenAiDesignModelClient implements DesignModelClient {
  private readonly client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  async complete(input: DesignModelInvocation & ModelInvocationOptions): Promise<string> {
    const imageBlocks = collectProcessedAttachmentImages(input.processedAttachments).map((image) => ({
      type: "image_url" as const,
      image_url: {
        url: `data:${image.mimeType};base64,${image.data.toString("base64")}`,
      },
    }));

    const completion = await this.client.chat.completions.create({
      model: input.model,
      temperature: input.temperature ?? 0.2,
      max_completion_tokens: input.maxTokens,
      messages: [
        {
          role: "system",
          content: input.systemPrompt,
        },
        ...input.messages.slice(0, -1).map((message) => ({
          role: message.role,
          content: message.content,
        })),
        {
          role: "user",
          content: [
            {
              type: "text",
              text: input.messages.at(-1)?.content ?? "",
            },
            ...imageBlocks,
          ],
        },
      ] as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) {
      throw new Error("OpenAI returned an empty response.");
    }

    return content;
  }
}

export class AnthropicDesignModelClient implements DesignModelClient {
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async complete(input: DesignModelInvocation & ModelInvocationOptions): Promise<string> {
    const conversation: Array<{
      role: "user" | "assistant";
      content: string;
    }> = input.messages.slice(0, -1).map((message) => ({
      role: message.role === "assistant" ? "assistant" : "user",
      content: message.content,
    }));

    const attachmentImages = collectProcessedAttachmentImages(input.processedAttachments).map((image) => ({
      type: "image" as const,
      source: {
        type: "base64" as const,
        media_type: image.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
        data: image.data.toString("base64"),
      },
    }));

    const response = await this.client.messages.create({
      model: input.model,
      max_tokens: input.maxTokens ?? 4096,
      temperature: input.temperature ?? 0.2,
      system: input.systemPrompt,
      messages: [
        ...conversation,
        {
          role: "user",
          content: [
            {
              type: "text",
              text: input.messages.at(-1)?.content ?? "",
            },
            ...attachmentImages,
          ],
        },
      ],
    });

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();

    if (!text) {
      throw new Error("Anthropic returned an empty response.");
    }

    return text;
  }
}

class AiConversationSummarizer implements ConversationSummarizer {
  constructor(
    private readonly client: DesignModelClient,
    private readonly model: ModelConfig,
  ) {}

  async summarize(input: {
    prompt: string;
    messages: ConversationMessageRecord[];
  }): Promise<string> {
    return this.client.complete({
      model: this.model.model,
      systemPrompt:
        "You summarize long-running design conversations. Return concise markdown bullets covering design decisions, created or modified components, current visual state, and unresolved issues. Do not include conversational filler.",
      messages: [
        {
          role: "user",
          content: [
            input.prompt,
            "",
            "Conversation history:",
            ...input.messages.map(
              (message, index) =>
                `${index + 1}. [${message.role}] ${message.content} (${message.designStateHash ?? "no-state"})`,
            ),
          ].join("\n"),
        },
      ],
      processedAttachments: [],
      maxTokens: 1200,
      temperature: 0.1,
    });
  }
}

class AiProjectMemoryUpdater implements ProjectMemoryUpdater {
  constructor(
    private readonly client: DesignModelClient,
    private readonly model: ModelConfig,
  ) {}

  async updateProjectMemory(input: ProjectMemoryUpdateInput): Promise<string> {
    return this.client.complete({
      model: this.model.model,
      systemPrompt:
        "You maintain a persistent project-memory.md file for an AI Figma editing tool. Return markdown only. Summarize current design state, recent changes, known issues, and stable design decisions. Keep it concise, factual, and durable across future edits.",
      messages: [
        {
          role: "user",
          content: [
            input.prompt,
            "",
            `Existing memory:\n${input.existingMemory ?? "No existing memory."}`,
            "",
            "Recent snapshots:",
            ...input.recentSnapshots.map(
              (snapshot) =>
                `- Revision ${snapshot.revisionNumber} (${snapshot.designStateHash}): ${snapshot.semantic.slice(0, 1800)}`,
            ),
            "",
            "Diffs:",
            ...input.diffs.map(
              (diff, index) =>
                `- Diff ${index + 1}: added=${diff.added.slice(0, 6).join(" | ") || "none"}; removed=${
                  diff.removed.slice(0, 6).join(" | ") || "none"
                }`,
            ),
          ].join("\n"),
        },
      ],
      processedAttachments: [],
      maxTokens: 1800,
      temperature: 0.1,
    });
  }
}

export class FigmaPluginWebSocketClient implements FigmaPluginBridge {
  private readonly url: string;
  private readonly timeoutMs: number;
  private socket: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private readonly pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timeout: NodeJS.Timeout;
    }
  >();

  constructor(url: string, timeoutMs = 30_000) {
    this.url = url;
    this.timeoutMs = timeoutMs;
  }

  async executeCode(code: string): Promise<FigmaPluginExecutionResult> {
    const result = (await this.request("executeCode", { code })) as Partial<FigmaPluginExecutionResult>;
    return {
      success: Boolean(result.success),
      nodeIds: (result.nodeIds as Record<string, string>) ?? {},
      ...(result.error ? { error: String(result.error) } : {}),
    };
  }

  async createVersion(label: string): Promise<string | null> {
    const result = (await this.request("createVersion", { label })) as { versionId?: string | null };
    return result.versionId ?? null;
  }

  async restoreVersion(versionId: string): Promise<void> {
    await this.request("restoreVersion", { versionId });
  }

  async getPreviewThumbnail(nodeId?: string): Promise<string | null> {
    const result = (await this.request("getPreviewThumbnail", { nodeId })) as {
      thumbnail?: string | null;
    };
    return result.thumbnail ?? null;
  }

  async disconnect(): Promise<void> {
    if (!this.socket) {
      return;
    }
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("WebSocket closed before a pending response returned."));
    }
    this.pending.clear();
    const socket = this.socket;
    this.socket = null;
    this.connectPromise = null;
    await new Promise<void>((resolve) => {
      socket.once("close", () => resolve());
      socket.close();
    });
  }

  private async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    await this.ensureConnected();
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Figma plugin bridge is not connected.");
    }

    const id = nanoid();
    const payload = JSON.stringify({ id, method, params });

    return await new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for plugin response to ${method}.`));
      }, this.timeoutMs);

      this.pending.set(id, {
        resolve,
        reject,
        timeout,
      });

      this.socket?.send(payload, (error) => {
        if (!error) {
          return;
        }
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  private async ensureConnected(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) {
      return;
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.url);

      const cleanup = () => {
        socket.removeAllListeners("open");
        socket.removeAllListeners("error");
      };

      socket.once("open", () => {
        cleanup();
        this.socket = socket;
        this.bindSocket(socket);
        resolve();
      });
      socket.once("error", (error) => {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    }).finally(() => {
      this.connectPromise = null;
    });

    return this.connectPromise;
  }

  private bindSocket(socket: WebSocket): void {
    socket.on("message", (raw) => {
      let message: {
        id?: string;
        ok?: boolean;
        result?: unknown;
        error?: string;
      };
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (!message.id) {
        return;
      }

      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }

      clearTimeout(pending.timeout);
      this.pending.delete(message.id);

      if (message.ok === false) {
        pending.reject(new Error(message.error || "Figma plugin bridge request failed."));
        return;
      }

      pending.resolve(message.result);
    });

    socket.on("close", () => {
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timeout);
        pending.reject(new Error(`Plugin bridge closed before request ${id} completed.`));
      }
      this.pending.clear();
      this.socket = null;
    });

    socket.on("error", (error) => {
      for (const [, pending] of this.pending) {
        clearTimeout(pending.timeout);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
      this.pending.clear();
    });
  }
}

export class FigmaMakeClone {
  readonly models = {
    default: { provider: "anthropic", model: "claude-sonnet-4-20250514" },
    fast: { provider: "openai", model: "gpt-4o-mini" },
    powerful: { provider: "anthropic", model: "claude-opus-4-20250514" },
  } as const satisfies Record<ModelProfileName, ModelConfig>;

  systemPrompt = `You are an expert UI designer and React developer working inside a
Figma-integrated design tool. You make edits to Figma designs by describing the
changes as structured JSON operations.

CRITICAL RULES:
- Always use components from the design system when available
- Respect auto-layout structure — never use absolute positioning inside auto-layout frames
- Use bound variables/tokens for colors and spacing, not raw values
- When modifying existing designs, preserve the node tree structure
- Explain what you're changing before the operation JSON

{guidelines}

CURRENT DESIGN STATE:
{design_state}

PROJECT MEMORY:
{project_memory}

Respond with your explanation followed by a JSON code block containing an array of
operations. Each operation must match the OperationGraph input schema.`;

  private readonly options: FigmaMakeCloneOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly projectRootDir: string;
  private readonly guidelineStore: GuidelineStore;
  private readonly guidelineRouter: GuidelineRouter;
  private readonly conversationStore: ConversationStore;
  private readonly contextWindowManager: ContextWindowManager;
  private readonly designStateTracker: DesignStateTracker;
  private readonly promptAssembler: PromptAssembler;
  private readonly attachmentManager: AttachmentManager;
  private readonly tokenCounter: TokenCounter;
  private readonly aiClients: Partial<Record<ModelProvider, DesignModelClient>>;
  private readonly pluginClient: FigmaPluginBridge;
  private readonly parser: AIResponseParser;
  private readonly graph: OperationGraph;
  private readonly compiler: OperationCompiler;
  private readonly checkpointsFilePath: string;
  private readonly conversationFilePath: string;
  private readonly snapshotsFilePath: string;
  private readonly memoryFilePath: string;

  constructor(options: FigmaMakeCloneOptions) {
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.projectRootDir = path.join(
      options.stateDir,
      DEFAULT_STATE_SUBDIR,
      sanitizePathSegment(options.projectId),
    );

    this.tokenCounter = new TokenCounter();
    this.guidelineStore = new GuidelineStore({
      rootDir: options.guidelineRootDir ?? path.join(this.projectRootDir, "guidelines"),
    });
    this.guidelineRouter = new GuidelineRouter(this.guidelineStore);

    this.conversationFilePath = path.join(this.projectRootDir, "ai_chat.json");
    this.snapshotsFilePath = path.join(this.projectRootDir, "design-state-history.json");
    this.memoryFilePath = path.join(this.projectRootDir, "project-memory.md");
    this.checkpointsFilePath = path.join(this.projectRootDir, CHECKPOINTS_FILE);

    this.conversationStore = new ConversationStore(this.conversationFilePath, this.tokenCounter);
    this.aiClients = {
      ...options.aiClients,
    };
    if (!this.aiClients.openai) {
      const apiKey = options.openaiApiKey ?? process.env.OPENAI_API_KEY;
      if (apiKey) {
        this.aiClients.openai = new OpenAiDesignModelClient(apiKey);
      }
    }
    if (!this.aiClients.anthropic) {
      const apiKey = options.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY;
      if (apiKey) {
        this.aiClients.anthropic = new AnthropicDesignModelClient(apiKey);
      }
    }

    this.pluginClient =
      options.pluginClient ??
      new FigmaPluginWebSocketClient(
        options.pluginUrl ?? "ws://127.0.0.1:8765",
      );

    if (options.systemPrompt) {
      this.systemPrompt = options.systemPrompt;
    }

    const summarizer = this.buildConversationSummarizer();
    const memoryUpdater = this.buildProjectMemoryUpdater();

    this.contextWindowManager = new ContextWindowManager(this.conversationStore, this.tokenCounter, {
      summarizer,
    });
    this.designStateTracker = new DesignStateTracker({
      snapshotsFilePath: this.snapshotsFilePath,
      projectMemoryFilePath: this.memoryFilePath,
      memoryUpdater,
    });
    this.promptAssembler = new PromptAssembler(
      this.guidelineStore,
      this.guidelineRouter,
      this.contextWindowManager,
      this.designStateTracker,
      this.tokenCounter,
      {
        fixedInstructions:
          "You are a design-aware Figma editing assistant. Preserve user intent and describe only the changes that matter.",
      },
    );
    this.attachmentManager = new AttachmentManager({
      tokenCounter: this.tokenCounter,
      fetchImpl: this.fetchImpl,
    });

    this.parser = new AIResponseParser();
    this.graph = new OperationGraph();
    this.compiler = new OperationCompiler();
  }

  async handlePrompt(
    userMessage: string,
    attachments: File[] = [],
    options: HandlePromptOptions = {},
  ): Promise<EditResult> {
    await this.ensureInitialized();

    if (!userMessage.trim()) {
      return {
        success: false,
        dryRun: Boolean(options.dryRun),
        explanation: "",
        rawAiResponse: null,
        modelProfile: options.modelProfile ?? this.options.defaultModelProfile ?? "default",
        model: this.resolveModel(options.modelProfile),
        operationsJson: null,
        operations: [],
        compiledCode: null,
        validation: null,
        execution: null,
        checkpoint: null,
        previewThumbnail: null,
        tokenCount: 0,
        designStateHash: null,
        warnings: [],
        error: "Prompt cannot be empty.",
      };
    }

    const currentState = await this.fetchCurrentDesignState();
    await this.ensureBaselineSnapshot(currentState);
    await this.ensureInitialProjectMessage(currentState.designStateHash);

    const fileValidation = this.attachmentManager.validate(attachments);
    if (!fileValidation.valid) {
      return this.failureResult({
        dryRun: Boolean(options.dryRun),
        modelProfile: options.modelProfile ?? this.options.defaultModelProfile ?? "default",
        model: this.resolveModel(options.modelProfile),
        currentState,
        warnings: fileValidation.warnings,
        error: fileValidation.errors.join(" "),
      });
    }

    const processedAttachments = await this.processAttachments(
      attachments,
      options.additionalAttachments ?? [],
    );
    const attachmentWarnings = processedAttachments
      .flatMap((attachment) => [
        ...(attachment.error
          ? [`${attachment.filename}: ${attachment.error}`]
          : []),
        ...attachment.warnings.map((warning) => `${attachment.filename}: ${warning}`),
      ])
      .slice(0, 10);

    const modelProfile = options.modelProfile ?? this.options.defaultModelProfile ?? "default";
    const model = this.resolveModel(modelProfile);
    const client = this.aiClients[model.provider];
    if (!client) {
      return this.failureResult({
        dryRun: Boolean(options.dryRun),
        modelProfile,
        model,
        currentState,
        warnings: attachmentWarnings,
        error: `${model.provider} client is not configured.`,
      });
    }

    this.promptAssembler.setPendingAttachments(
      processedAttachments.map((attachment) => attachment.filename),
    );
    const promptAssembly = await this.promptAssembler.assemblePrompt(userMessage);
    const guidelines = await this.guidelineRouter.loadForPrompt(userMessage);
    const projectMemory =
      (await this.designStateTracker.readProjectMemory()) ?? "No project memory file yet.";
    const renderedSystemPrompt = this.renderSystemPrompt({
      guidelines,
      designState: currentState.semantic,
      projectMemory,
    });
    const conversationMessages = promptAssembly.messages.slice(3, -1);
    const userPromptContent = this.buildUserPromptContent(
      userMessage,
      processedAttachments,
      [],
    );

    await this.conversationStore.addMessage({
      role: "user",
      content: userPromptContent,
      designStateHash: currentState.designStateHash,
    });

    const maxRetries = Math.max(1, options.maxRetries ?? DEFAULT_MAX_RETRIES);
    const attemptFeedback: string[] = [];
    let lastError: string | null = null;
    let lastRawAiResponse: string | null = null;
    let lastExplanation = "";
    let lastOperationsJson: string | null = null;
    let lastOperations: FigmaOperation[] = [];
    let lastValidation: OperationValidationResult | null = null;
    let lastCompiledCode: string | null = null;
    const safetyVersionId =
      options.dryRun !== true
        ? await this.pluginClient
            .createVersion(`[safety] ${buildCheckpointLabel(userMessage)}`)
            .catch(() => null)
        : null;

    for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
      try {
        const finalMessages: PromptMessage[] = [
          { role: "system", content: renderedSystemPrompt },
          ...conversationMessages,
          {
            role: "user",
            content: this.buildUserPromptContent(
              userMessage,
              processedAttachments,
              attemptFeedback,
            ),
          },
        ];
        const tokenCount = this.tokenCounter.countMessages(finalMessages);

        const rawAiResponse = await client.complete({
          model: model.model,
          systemPrompt: renderedSystemPrompt,
          messages: finalMessages,
          processedAttachments,
        });
        lastRawAiResponse = rawAiResponse;

        const parsed = this.parser.parse(rawAiResponse);
        const explanation = extractExplanation(rawAiResponse);
        const buildResult = this.graph.build(parsed.instruction);
        const compilation = this.compiler.compile(buildResult.operations);

        lastExplanation = explanation;
        lastOperationsJson = parsed.normalizedJson;
        lastOperations = compilation.validation.operations;
        lastValidation = compilation.validation;
        lastCompiledCode = compilation.code;

        if (!compilation.validation.valid) {
          const validationError = compilation.validation.errors.join(" ");
          lastError = validationError || "Operation validation failed.";
          attemptFeedback.push(
            `Attempt ${attempt} failed validation: ${lastError}`,
          );
          continue;
        }

        if (options.dryRun) {
          await this.conversationStore.addMessage({
            role: "assistant",
            content: explanation || "Prepared a dry-run edit plan.",
            designStateHash: currentState.designStateHash,
          });

          return {
            success: true,
            dryRun: true,
            explanation: explanation || "Prepared a dry-run edit plan.",
            rawAiResponse,
            modelProfile,
            model,
            operationsJson: parsed.normalizedJson,
            operations: compilation.validation.operations,
            compiledCode: compilation.code,
            validation: compilation.validation,
            execution: null,
            checkpoint: null,
            previewThumbnail: await this.capturePreviewThumbnail(),
            tokenCount,
            designStateHash: currentState.designStateHash,
            warnings: [
              ...buildResult.warnings,
              ...compilation.validation.warnings,
              ...attachmentWarnings,
            ],
          };
        }

        const execution = await this.pluginClient.executeCode(compilation.code);
        if (!execution.success) {
          await this.restoreSafetyVersion(safetyVersionId);
          lastError = execution.error || "The Figma plugin reported a failed execution.";
          attemptFeedback.push(`Attempt ${attempt} failed during plugin execution: ${lastError}`);
          continue;
        }

        const nextState = await this.fetchCurrentDesignState();
        await this.designStateTracker.captureSnapshot({
          file: nextState.file,
          targetNodeId: this.options.rootNodeId,
        });
        await this.conversationStore.addMessage({
          role: "assistant",
          content: explanation || "Applied the requested design changes.",
          designStateHash: nextState.designStateHash,
        });

        const checkpoint =
          options.createCheckpoint === false
            ? null
            : await this.createCheckpointInternal(
                options.checkpointLabel ?? buildCheckpointLabel(userMessage),
                nextState,
              );

        return {
          success: true,
          dryRun: false,
          explanation: explanation || "Applied the requested design changes.",
          rawAiResponse,
          modelProfile,
          model,
          operationsJson: parsed.normalizedJson,
          operations: compilation.validation.operations,
          compiledCode: compilation.code,
          validation: compilation.validation,
          execution,
          checkpoint,
          previewThumbnail: await this.capturePreviewThumbnail(),
          tokenCount,
          designStateHash: nextState.designStateHash,
          warnings: [
            ...buildResult.warnings,
            ...compilation.validation.warnings,
            ...attachmentWarnings,
          ],
        };
      } catch (error) {
        await this.restoreSafetyVersion(safetyVersionId);
        lastError = error instanceof Error ? error.message : String(error);
        attemptFeedback.push(`Attempt ${attempt} failed: ${lastError}`);
      }
    }

    await this.conversationStore.addMessage({
      role: "assistant",
      content: `The edit could not be completed safely. ${lastError ?? "Unknown failure."}`,
      designStateHash: currentState.designStateHash,
    });

    return {
      success: false,
      dryRun: Boolean(options.dryRun),
      explanation: lastExplanation,
      rawAiResponse: lastRawAiResponse,
      modelProfile,
      model,
      operationsJson: lastOperationsJson,
      operations: lastOperations,
      compiledCode: lastCompiledCode,
      validation: lastValidation,
      execution: null,
      checkpoint: null,
      previewThumbnail: await this.capturePreviewThumbnail(),
      tokenCount: promptAssembly.tokenCount,
      designStateHash: currentState.designStateHash,
      warnings: attachmentWarnings,
      error: lastError ?? "The edit could not be completed safely.",
    };
  }

  async createCheckpoint(label: string): Promise<Checkpoint> {
    await this.ensureInitialized();
    const state = await this.fetchCurrentDesignState();
    return this.createCheckpointInternal(label, state);
  }

  async restoreCheckpoint(checkpointId: string): Promise<void> {
    await this.ensureInitialized();
    const checkpoints = await this.readCheckpoints();
    const checkpoint = checkpoints.find((entry) => entry.id === checkpointId);
    if (!checkpoint) {
      throw new Error(`Checkpoint ${checkpointId} was not found.`);
    }

    await this.conversationStore.replaceState(checkpoint.conversationState);
    await this.designStateTracker.replaceSnapshots(checkpoint.designSnapshots);
    await this.designStateTracker.writeProjectMemory(checkpoint.projectMemory);

    if (checkpoint.figmaVersionId) {
      await this.pluginClient.restoreVersion(checkpoint.figmaVersionId);
    }
  }

  private async createCheckpointInternal(
    label: string,
    currentState: SerializedCurrentState,
  ): Promise<Checkpoint> {
    const checkpoints = await this.readCheckpoints();
    const snapshots = await this.designStateTracker.getSnapshots();
    const conversationState = await this.conversationStore.exportState();
    const projectMemory = await this.designStateTracker.readProjectMemory();

    const checkpoint: Checkpoint = {
      id: nanoid(),
      label,
      createdAt: new Date().toISOString(),
      designStateHash: currentState.designStateHash,
      figmaVersionId: await this.pluginClient.createVersion(label).catch(() => null),
      conversationState,
      designSnapshots: snapshots,
      projectMemory,
    };

    checkpoints.push(checkpoint);
    await fs.writeFile(this.checkpointsFilePath, JSON.stringify(checkpoints, null, 2), "utf8");
    return checkpoint;
  }

  private async processAttachments(
    files: File[],
    additionalSources: AttachmentSourceInput[],
  ): Promise<ProcessedAttachment[]> {
    const fileSources = await Promise.all(
      files.map(async (file) => ({
        kind: "stored" as const,
        id: nanoid(),
        filename: file.name,
        mimeType: file.type || inferMimeType(file.name),
        data: Buffer.from(await file.arrayBuffer()),
      })),
    );

    return this.attachmentManager.processSources([...fileSources, ...additionalSources]);
  }

  private resolveModel(profile?: ModelProfileName): ModelConfig {
    return this.models[profile ?? this.options.defaultModelProfile ?? "default"];
  }

  private async ensureInitialized(): Promise<void> {
    await fs.mkdir(this.projectRootDir, { recursive: true });
    await fs.mkdir(path.dirname(this.checkpointsFilePath), { recursive: true });
    try {
      await fs.access(this.checkpointsFilePath);
    } catch {
      await fs.writeFile(this.checkpointsFilePath, "[]\n", "utf8");
    }
  }

  private buildConversationSummarizer(): ConversationSummarizer | undefined {
    const client = this.aiClients.openai ?? this.aiClients.anthropic;
    if (!client) {
      return undefined;
    }
    const model = this.aiClients.openai ? this.models.fast : this.models.default;
    return new AiConversationSummarizer(client, model);
  }

  private buildProjectMemoryUpdater(): ProjectMemoryUpdater | undefined {
    const client = this.aiClients.anthropic ?? this.aiClients.openai;
    if (!client) {
      return undefined;
    }
    const model = this.aiClients.anthropic ? this.models.default : this.models.fast;
    return new AiProjectMemoryUpdater(client, model);
  }

  private async ensureInitialProjectMessage(designStateHash: string): Promise<void> {
    if (!this.options.initialProjectDescription) {
      return;
    }
    const messages = await this.conversationStore.getMessages();
    if (messages.length > 0) {
      return;
    }
    await this.conversationStore.addMessage({
      role: "user",
      content: this.options.initialProjectDescription,
      designStateHash,
    });
  }

  private async ensureBaselineSnapshot(currentState: SerializedCurrentState): Promise<void> {
    const tracked = await this.designStateTracker.getCurrentState();
    if (tracked?.designStateHash === currentState.designStateHash) {
      return;
    }

    await this.designStateTracker.captureSnapshot({
      file: currentState.file,
      targetNodeId: this.options.rootNodeId,
    });
  }

  private renderSystemPrompt(params: {
    guidelines: string;
    designState: string;
    projectMemory: string;
  }): string {
    return this.systemPrompt
      .replace("{guidelines}", params.guidelines || "No design system guidelines were loaded.")
      .replace("{design_state}", params.designState || "No current design state available.")
      .replace("{project_memory}", params.projectMemory || "No project memory file yet.");
  }

  private buildUserPromptContent(
    userMessage: string,
    processedAttachments: ProcessedAttachment[],
    attemptFeedback: string[],
  ): string {
    const attachmentPrompt = formatProcessedAttachmentsForPrompt(processedAttachments);
    return [
      userMessage.trim(),
      attemptFeedback.length
        ? [
            "Retry guidance from previous failed attempts:",
            ...attemptFeedback.map((item) => `- ${item}`),
          ].join("\n")
        : "",
      attachmentPrompt,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  private async fetchCurrentDesignState(): Promise<SerializedCurrentState> {
    const { file, localVariables } = await this.fetchFigmaFile();
    const serialized = serializeFigmaDesignContext(file as FileResponse, this.options.rootNodeId, {
      localVariables,
    });

    return {
      file: file as FileResponse,
      localVariables,
      semantic: serialized.semantic,
      sparse: serialized.sparse,
      variables: serialized.variables,
      warnings: serialized.warnings,
      designStateHash: sha256(serialized.semantic || serialized.sparse || JSON.stringify(serialized.variables)),
      versionId: file.version,
    };
  }

  private async fetchFigmaFile(): Promise<FigmaFilePayload> {
    const headers = {
      "X-Figma-Token": this.options.figmaToken,
    };

    const [fileResponse, variablesResponse] = await Promise.all([
      this.fetchImpl(`https://api.figma.com/v1/files/${this.options.fileKey}`, { headers }),
      this.fetchImpl(
        `https://api.figma.com/v1/files/${this.options.fileKey}/variables/local`,
        { headers },
      ),
    ]);

    if (!fileResponse.ok) {
      throw new Error(`Could not fetch the Figma file (${fileResponse.status}).`);
    }

    return {
      file: (await fileResponse.json()) as GetFileResponse,
      localVariables: variablesResponse.ok
        ? ((await variablesResponse.json()) as GetLocalVariablesResponse)
        : null,
    };
  }

  private async capturePreviewThumbnail(): Promise<string | null> {
    try {
      const pluginThumbnail = await this.pluginClient.getPreviewThumbnail(this.options.rootNodeId);
      if (pluginThumbnail) {
        return pluginThumbnail;
      }
    } catch {
      // Fall back to the REST API thumbnail.
    }

    const response = await this.fetchImpl(
      `https://api.figma.com/v1/images/${this.options.fileKey}?ids=${encodeURIComponent(this.options.rootNodeId)}&format=png&scale=1`,
      {
        headers: {
          "X-Figma-Token": this.options.figmaToken,
        },
      },
    );
    if (!response.ok) {
      return null;
    }
    const payload = (await response.json()) as { images?: Record<string, string> };
    return payload.images?.[this.options.rootNodeId] ?? null;
  }

  private async readCheckpoints(): Promise<Checkpoint[]> {
    try {
      const raw = await fs.readFile(this.checkpointsFilePath, "utf8");
      return JSON.parse(raw) as Checkpoint[];
    } catch {
      return [];
    }
  }

  private async restoreSafetyVersion(versionId: string | null): Promise<void> {
    if (!versionId) {
      return;
    }

    try {
      await this.pluginClient.restoreVersion(versionId);
    } catch {
      // Best-effort rollback only.
    }
  }

  private failureResult(input: {
    dryRun: boolean;
    modelProfile: ModelProfileName;
    model: ModelConfig;
    currentState: SerializedCurrentState;
    warnings: string[];
    error: string;
  }): EditResult {
    return {
      success: false,
      dryRun: input.dryRun,
      explanation: "",
      rawAiResponse: null,
      modelProfile: input.modelProfile,
      model: input.model,
      operationsJson: null,
      operations: [],
      compiledCode: null,
      validation: null,
      execution: null,
      checkpoint: null,
      previewThumbnail: null,
      tokenCount: 0,
      designStateHash: input.currentState.designStateHash,
      warnings: input.warnings,
      error: input.error,
    };
  }
}

function extractExplanation(raw: string): string {
  const fencedMatch = raw.match(/```(?:json)?\s*[\[{][\s\S]*?```/i);
  if (fencedMatch && fencedMatch.index !== undefined) {
    return raw.slice(0, fencedMatch.index).trim();
  }

  const jsonIndexCandidates = [raw.indexOf("{"), raw.indexOf("[")].filter((value) => value >= 0);
  if (jsonIndexCandidates.length > 0) {
    return raw.slice(0, Math.min(...jsonIndexCandidates)).trim();
  }

  return raw.trim();
}

function buildCheckpointLabel(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  return normalized.length <= 48 ? normalized : `${normalized.slice(0, 45).trimEnd()}...`;
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function inferMimeType(filename: string): string {
  const extension = path.extname(filename).toLowerCase();
  if (extension === ".pdf") return "application/pdf";
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".gif") return "image/gif";
  if (extension === ".svg") return "image/svg+xml";
  if (extension === ".json") return "application/json";
  return "text/plain";
}
