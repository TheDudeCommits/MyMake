import type { ProcessedAttachment } from "@/lib/server/attachment-manager";
import type {
  AiModelKey,
  AiModelOption,
  EditMode,
  EditPlan,
  SelectionPayload,
  SelectionTarget,
} from "@/lib/types";
import { getEnv } from "@/lib/server/env";
import {
  requestAnthropicAiEdit,
  requestAnthropicPatchEdit,
  type ContextFile,
} from "@/lib/server/anthropic";
import { requestOpenAiEdit, requestOpenAiPatchEdit } from "@/lib/server/openai";

interface ServerAiModelConfig {
  key: AiModelKey;
  label: string;
  provider: AiModelOption["provider"];
  apiModel: string;
}

const AI_MODELS: ServerAiModelConfig[] = [
  {
    key: "openai-chatgpt-5-2",
    label: "OpenAI ChatGPT 5.2",
    provider: "openai",
    apiModel: "gpt-5.2-chat-latest",
  },
  {
    key: "openai-codex",
    label: "Codex",
    provider: "openai",
    apiModel: "gpt-5.3-codex",
  },
  {
    key: "anthropic-sonnet-4-6",
    label: "Claude Sonnet 4.6",
    provider: "anthropic",
    apiModel: "claude-sonnet-4-20250514",
  },
];

export const DEFAULT_AI_MODEL_KEY: AiModelKey = "anthropic-sonnet-4-6";

export function isCodexModel(aiModelKey?: AiModelKey | null): boolean {
  return aiModelKey === "openai-codex";
}

export function listAiModels(): AiModelOption[] {
  const env = getEnv();

  return AI_MODELS.map((model) => ({
    key: model.key,
    label: model.label,
    provider: model.provider,
    enabled:
      model.key === "openai-codex"
        ? true
        : model.provider === "openai"
        ? Boolean(env.openaiApiKey)
        : Boolean(env.anthropicApiKey),
  }));
}

function resolveAiModel(aiModelKey?: AiModelKey | null): ServerAiModelConfig {
  const model =
    AI_MODELS.find((item) => item.key === aiModelKey) ||
    AI_MODELS.find((item) => item.key === DEFAULT_AI_MODEL_KEY) ||
    AI_MODELS[0];

  if (model.provider === "openai" && !getEnv().openaiApiKey) {
    throw new Error(`Add OPENAI_API_KEY to use ${model.label}.`);
  }

  if (model.provider === "anthropic" && !getEnv().anthropicApiKey) {
    throw new Error("Claude Sonnet 4.6 is not configured. Add ANTHROPIC_API_KEY to use it.");
  }

  return model;
}

export async function requestAiEdit(params: {
  aiModelKey?: AiModelKey | null;
  prompt: string;
  editMode: EditMode;
  selection: SelectionPayload | null;
  selectionTarget: SelectionTarget | null;
  editPlan: EditPlan;
  currentFilePath?: string | null;
  contextFiles: ContextFile[];
  contextSummary?: string | null;
  guidelinesText?: string | null;
  projectMemoryText?: string | null;
  conversationHistoryText?: string | null;
  currentStateText?: string | null;
  activeKitSummaries?: string[];
  attachments: ProcessedAttachment[];
}): Promise<{
  summary: string;
  warnings: string[];
  changedFiles: Array<{ path: string; content: string; reason?: string }>;
  rawResponse: string | null;
}> {
  const model = resolveAiModel(params.aiModelKey);

  if (model.provider === "openai") {
    return requestOpenAiEdit({
      model: model.apiModel,
      prompt: params.prompt,
      editMode: params.editMode,
      selection: params.selection,
      selectionTarget: params.selectionTarget,
      editPlan: params.editPlan,
      currentFilePath: params.currentFilePath || undefined,
      contextFiles: params.contextFiles,
      contextSummary: params.contextSummary,
      guidelinesText: params.guidelinesText,
      projectMemoryText: params.projectMemoryText,
      conversationHistoryText: params.conversationHistoryText,
      currentStateText: params.currentStateText,
      activeKitSummaries: params.activeKitSummaries,
      attachments: params.attachments,
    });
  }

  return requestAnthropicAiEdit({
    model: model.apiModel,
    prompt: params.prompt,
    editMode: params.editMode,
    selection: params.selection,
    selectionTarget: params.selectionTarget,
    editPlan: params.editPlan,
    currentFilePath: params.currentFilePath || undefined,
    contextFiles: params.contextFiles,
    contextSummary: params.contextSummary,
    guidelinesText: params.guidelinesText,
    projectMemoryText: params.projectMemoryText,
    conversationHistoryText: params.conversationHistoryText,
    currentStateText: params.currentStateText,
    activeKitSummaries: params.activeKitSummaries,
    attachments: params.attachments,
  });
}

export async function requestAiPatchEdit(params: {
  aiModelKey?: AiModelKey | null;
  prompt: string;
  editMode: EditMode;
  selection: SelectionPayload | null;
  selectionTarget: SelectionTarget | null;
  editPlan: EditPlan;
  currentFilePath: string;
  contextFiles: ContextFile[];
  contextSummary?: string | null;
  guidelinesText?: string | null;
  projectMemoryText?: string | null;
  conversationHistoryText?: string | null;
  currentStateText?: string | null;
  activeKitSummaries?: string[];
  attachments: ProcessedAttachment[];
}): Promise<{
  summary: string;
  warnings: string[];
  operations: Array<{ path: string; search: string; replace: string; reason?: string }>;
  rawResponse: string | null;
}> {
  const model = resolveAiModel(params.aiModelKey);

  if (model.provider === "openai") {
    return requestOpenAiPatchEdit({
      model: model.apiModel,
      prompt: params.prompt,
      editMode: params.editMode,
      selection: params.selection,
      selectionTarget: params.selectionTarget,
      editPlan: params.editPlan,
      currentFilePath: params.currentFilePath,
      contextFiles: params.contextFiles,
      contextSummary: params.contextSummary,
      guidelinesText: params.guidelinesText,
      projectMemoryText: params.projectMemoryText,
      conversationHistoryText: params.conversationHistoryText,
      currentStateText: params.currentStateText,
      activeKitSummaries: params.activeKitSummaries,
      attachments: params.attachments,
    });
  }

  return requestAnthropicPatchEdit({
    model: model.apiModel,
    prompt: params.prompt,
    editMode: params.editMode,
    selection: params.selection,
    selectionTarget: params.selectionTarget,
    editPlan: params.editPlan,
    currentFilePath: params.currentFilePath,
    contextFiles: params.contextFiles,
    contextSummary: params.contextSummary,
    guidelinesText: params.guidelinesText,
    projectMemoryText: params.projectMemoryText,
    conversationHistoryText: params.conversationHistoryText,
    currentStateText: params.currentStateText,
    activeKitSummaries: params.activeKitSummaries,
    attachments: params.attachments,
  });
}
