import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

import { getEnv } from "@/lib/server/env";
import type {
  AiChangedFile,
  AnthropicAttachment,
  EditMode,
  EditPlan,
  SelectionPayload,
  SelectionTarget,
} from "@/lib/types";

const changedFileSchema = z.object({
  path: z.string().default(""),
  content: z.string(),
  reason: z.string().optional(),
});

const patchOperationSchema = z.object({
  path: z.string().default(""),
  search: z.string().min(1),
  replace: z.string(),
  reason: z.string().optional(),
});

const aiResponseSchema = z.object({
  summary: z.string().min(1),
  warnings: z.array(z.string()).default([]),
  changedFiles: z.array(changedFileSchema).min(1),
});

const aiPatchResponseSchema = z.object({
  summary: z.string().min(1),
  warnings: z.array(z.string()).default([]),
  operations: z.array(patchOperationSchema).min(1),
});

export interface ContextFile {
  path: string;
  content: string;
  reason: string;
}

function getAnthropicClient(): Anthropic {
  const { anthropicApiKey } = getEnv();
  if (!anthropicApiKey) {
    throw new Error("ANTHROPIC_API_KEY is not configured.");
  }

  return new Anthropic({ apiKey: anthropicApiKey });
}

function isStaticOverrideContext(params: {
  currentFilePath?: string;
  contextFiles: ContextFile[];
}): boolean {
  return (
    params.currentFilePath === "editable/overrides.config.js" ||
    params.contextFiles.some((file) => file.path === "editable/overrides.config.js")
  );
}

function staticOverrideInstructions(): string[] {
  return [
    "This project is a static Framer export with an editable override layer.",
    "Prefer editing editable/overrides.config.js or editable/overrides.css instead of rewriting raw HTML.",
    "Use window.__PLATFORM_OVERRIDES__.elements for exact selected-element changes.",
    "Each elements entry can use selector, scopeSelector, scopedSelector, nearestFramerName, hide/remove, styles, cssVars, text, find/replace, src, alt, href, rel, target, attributes, and customCss.",
    "Use sections[SECTION_NAME] only when the change should affect a broader Framer block.",
    "When a selection includes nearestFramerName or scopedSelector, preserve those hooks and target the selected element precisely.",
    "Never duplicate top-level keys in editable/overrides.config.js. Update the existing elements, global, sections, rootCssVars, or customCss values instead.",
  ];
}

function normalizeChangedFiles(
  changedFiles: z.infer<typeof changedFileSchema>[],
  currentFilePath?: string,
): AiChangedFile[] {
  return changedFiles.map((file) => {
    const normalizedPath = file.path.trim() || currentFilePath || "";
    if (!normalizedPath) {
      throw new Error("Claude did not specify which file to update.");
    }

    return {
      path: normalizedPath,
      content: file.content,
      ...(file.reason ? { reason: file.reason } : {}),
    };
  });
}

function normalizePatchOperations(
  operations: z.infer<typeof patchOperationSchema>[],
  currentFilePath?: string,
): Array<{ path: string; search: string; replace: string; reason?: string }> {
  return operations.map((operation) => {
    const normalizedPath = operation.path.trim() || currentFilePath || "";
    if (!normalizedPath) {
      throw new Error("Claude did not specify which file to patch.");
    }

    return {
      path: normalizedPath,
      search: operation.search,
      replace: operation.replace,
      ...(operation.reason ? { reason: operation.reason } : {}),
    };
  });
}

function stripMarkdownFence(value: string): string {
  return value
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function findFirstParsableJson(value: string): unknown | null {
  for (let startIndex = 0; startIndex < value.length; startIndex += 1) {
    const startCharacter = value[startIndex];
    if (startCharacter !== "{" && startCharacter !== "[") {
      continue;
    }

    const endCharacter = startCharacter === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let isEscaped = false;

    for (let index = startIndex; index < value.length; index += 1) {
      const character = value[index];

      if (inString) {
        if (isEscaped) {
          isEscaped = false;
          continue;
        }

        if (character === "\\") {
          isEscaped = true;
          continue;
        }

        if (character === "\"") {
          inString = false;
        }
        continue;
      }

      if (character === "\"") {
        inString = true;
        continue;
      }

      if (character === startCharacter) {
        depth += 1;
        continue;
      }

      if (character !== endCharacter) {
        continue;
      }

      depth -= 1;
      if (depth !== 0) {
        continue;
      }

      const candidate = value.slice(startIndex, index + 1);
      try {
        return JSON.parse(candidate);
      } catch {
        break;
      }
    }
  }

  return null;
}

function extractJsonFromText(value: string): unknown {
  const trimmed = value.trim();
  const candidates = Array.from(new Set([trimmed, stripMarkdownFence(trimmed)]));

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    try {
      return JSON.parse(candidate);
    } catch {
      const embeddedJson = findFirstParsableJson(candidate);
      if (embeddedJson !== null) {
        return embeddedJson;
      }
    }
  }

  throw new Error(
    `Claude returned a response that was not valid JSON. Received: ${trimmed.slice(0, 180)}`,
  );
}

function normalizeAiResponseShape(value: unknown): z.infer<typeof aiResponseSchema> {
  const changedFilesOnly = z.array(changedFileSchema).safeParse(value);
  if (changedFilesOnly.success) {
    return {
      summary: "Applied the requested code update.",
      warnings: [],
      changedFiles: changedFilesOnly.data,
    };
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    const candidate = value as Record<string, unknown>;
    const summary =
      typeof candidate.summary === "string" && candidate.summary.trim()
        ? candidate.summary.trim()
        : typeof candidate.message === "string" && candidate.message.trim()
          ? candidate.message.trim()
          : typeof candidate.explanation === "string" && candidate.explanation.trim()
            ? candidate.explanation.trim()
            : "Applied the requested code update.";

    const warnings = Array.isArray(candidate.warnings)
      ? candidate.warnings.filter((item): item is string => typeof item === "string")
      : [];

    for (const key of ["changedFiles", "files", "changes", "edits", "updatedFiles"]) {
      const parsedFiles = z.array(changedFileSchema).safeParse(candidate[key]);
      if (parsedFiles.success) {
        return {
          summary,
          warnings,
          changedFiles: parsedFiles.data,
        };
      }
    }
  }

  return aiResponseSchema.parse(value);
}

function normalizeAiPatchResponseShape(value: unknown): z.infer<typeof aiPatchResponseSchema> {
  const operationsOnly = z.array(patchOperationSchema).safeParse(value);
  if (operationsOnly.success) {
    return {
      summary: "Applied the requested UI update.",
      warnings: [],
      operations: operationsOnly.data,
    };
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    const candidate = value as Record<string, unknown>;
    const summary =
      typeof candidate.summary === "string" && candidate.summary.trim()
        ? candidate.summary.trim()
        : typeof candidate.message === "string" && candidate.message.trim()
          ? candidate.message.trim()
          : typeof candidate.explanation === "string" && candidate.explanation.trim()
            ? candidate.explanation.trim()
            : "Applied the requested UI update.";

    const warnings = Array.isArray(candidate.warnings)
      ? candidate.warnings.filter((item): item is string => typeof item === "string")
      : [];

    for (const key of ["operations", "patches", "edits", "replacements"]) {
      const parsedOperations = z.array(patchOperationSchema).safeParse(candidate[key]);
      if (parsedOperations.success) {
        return {
          summary,
          warnings,
          operations: parsedOperations.data,
        };
      }
    }
  }

  return aiPatchResponseSchema.parse(value);
}

function buildCommonContentBlocks(params: {
  prompt: string;
  editMode: EditMode;
  selection: SelectionPayload | null;
  selectionTarget: SelectionTarget | null;
  editPlan: EditPlan;
  contextFiles: ContextFile[];
  attachments: AnthropicAttachment[];
  currentFilePath?: string;
  allowedPaths?: string[];
  contextSummary?: string | null;
  activeKitSummaries?: string[];
}): Anthropic.Messages.ContentBlockParam[] {
  const contentBlocks: Anthropic.Messages.ContentBlockParam[] = [
    {
      type: "text",
      text: [
        `User prompt: ${params.prompt}`,
        `Edit mode: ${params.editMode}`,
        `Edit plan: ${JSON.stringify(params.editPlan, null, 2)}`,
        `Selected element: ${
          params.selection
            ? JSON.stringify(params.selection, null, 2)
            : "No element is currently selected."
        }`,
        `Semantic target: ${
          params.selectionTarget
            ? JSON.stringify(params.selectionTarget, null, 2)
            : "No semantic target available."
        }`,
        ...(params.currentFilePath ? [`Active file: ${params.currentFilePath}`] : []),
        ...(params.allowedPaths?.length
          ? [`Allowed file paths: ${params.allowedPaths.join(", ")}`]
          : []),
        ...(params.contextSummary ? [`Context memory:\n${params.contextSummary}`] : []),
        ...(params.activeKitSummaries?.length
          ? [`Active kits:\n- ${params.activeKitSummaries.join("\n- ")}`]
          : []),
        "Relevant source files:",
        ...params.contextFiles.map(
          (file) => `\n### ${file.path} (${file.reason})\n${file.content}`,
        ),
      ].join("\n"),
    },
  ];

  for (const attachment of params.attachments) {
    if (attachment.mimeType.startsWith("image/")) {
      contentBlocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: attachment.mimeType as
            | "image/jpeg"
            | "image/png"
            | "image/gif"
            | "image/webp",
          data: attachment.data.toString("base64"),
        },
      });
      contentBlocks.push({
        type: "text",
        text: `Image attachment: ${attachment.filename}`,
      });
      continue;
    }

    const decodedText = attachment.data.toString("utf8");
    contentBlocks.push({
      type: "text",
      text: `Attachment ${attachment.filename} (${attachment.mimeType}):\n${decodedText.slice(0, 12_000)}`,
    });
  }

  return contentBlocks;
}

export async function requestAiEdit(params: {
  model?: string;
  prompt: string;
  editMode: EditMode;
  selection: SelectionPayload | null;
  selectionTarget: SelectionTarget | null;
  editPlan: EditPlan;
  currentFilePath?: string;
  contextFiles: ContextFile[];
  contextSummary?: string | null;
  activeKitSummaries?: string[];
  attachments: AnthropicAttachment[];
}): Promise<{
  summary: string;
  warnings: string[];
  changedFiles: AiChangedFile[];
  rawResponse: string | null;
}> {
  const client = getAnthropicClient();

  const systemPrompt = [
    "You are MyMake, an expert UI editor that updates uploaded React frontend code.",
    "Return JSON only.",
    "Start the response immediately with { and end it immediately with }.",
    'Use this exact shape: {"summary":"...", "warnings":["..."], "changedFiles":[{"path":"relative/path.tsx","content":"full file contents","reason":"optional"}]}',
    "Always return full file contents for every changed file.",
    "Prefer minimal, local edits that preserve the project architecture.",
    "Do not reference files that are not included in changedFiles.",
    "Do not rename files, change relative import paths, or change export/import symbol names unless the user explicitly asks for that refactor.",
    "Preserve existing file paths and module wiring by default.",
    "Keep Tailwind and existing styling conventions intact unless the prompt explicitly asks for a larger redesign.",
    "Treat the provided edit plan and semantic target as hard constraints unless the prompt explicitly broadens the scope.",
    ...(isStaticOverrideContext(params) ? staticOverrideInstructions() : []),
  ].join("\n");

  const response = await client.messages.create({
    model: params.model || "claude-sonnet-4-20250514",
    max_tokens: 4096,
    system: systemPrompt,
    messages: [
      {
        role: "user",
        content: buildCommonContentBlocks(params),
      },
    ],
  });

  const responseText = response.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");

  const parsed = normalizeAiResponseShape(extractJsonFromText(responseText));

  return {
    ...parsed,
    changedFiles: normalizeChangedFiles(parsed.changedFiles, params.currentFilePath),
    rawResponse: responseText,
  };
}

export async function requestAnthropicPatchEdit(params: {
  model?: string;
  prompt: string;
  editMode: EditMode;
  selection: SelectionPayload | null;
  selectionTarget: SelectionTarget | null;
  editPlan: EditPlan;
  currentFilePath: string;
  contextFiles: ContextFile[];
  contextSummary?: string | null;
  activeKitSummaries?: string[];
  attachments: AnthropicAttachment[];
}): Promise<{
  summary: string;
  warnings: string[];
  operations: Array<{ path: string; search: string; replace: string; reason?: string }>;
  rawResponse: string | null;
}> {
  const client = getAnthropicClient();
  const allowedPaths = Array.from(
    new Set([params.currentFilePath, ...params.contextFiles.map((file) => file.path)]),
  );

  const systemPrompt = [
    "You are MyMake, an expert UI editor that updates uploaded frontend code.",
    "Return JSON only.",
    "The active file is too large to rewrite in full.",
    "Start the response immediately with { and end it immediately with }.",
    'Use this exact shape: {"summary":"...", "warnings":["..."], "operations":[{"path":"relative/path.html","search":"exact source text","replace":"replacement text","reason":"optional"}]}',
    "Produce precise search/replace operations instead of full file rewrites.",
    "Each operations.path must exactly match one of the allowed file paths provided by the user.",
    "Each search value must be copied exactly from the provided source snippets.",
    "Use an empty string in replace to remove content.",
    "Prefer 1-3 targeted operations.",
    "Honor the provided edit plan and semantic target when choosing search/replace operations.",
  ].join("\n");

  const response = await client.messages.create({
    model: params.model || "claude-sonnet-4-20250514",
    max_tokens: 4096,
    system: systemPrompt,
    messages: [
      {
        role: "user",
        content: buildCommonContentBlocks({
          ...params,
          allowedPaths,
        }),
      },
    ],
  });

  const responseText = response.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");

  const parsed = normalizeAiPatchResponseShape(extractJsonFromText(responseText));

  return {
    ...parsed,
    operations: normalizePatchOperations(parsed.operations, params.currentFilePath),
    rawResponse: responseText,
  };
}

export { requestAiEdit as requestAnthropicAiEdit };
