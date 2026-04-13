import OpenAI from "openai";
import { z } from "zod";

import {
  collectProcessedAttachmentImages,
  formatProcessedAttachmentsForPrompt,
  type ProcessedAttachment,
} from "@/lib/server/attachment-manager";
import { getEnv } from "@/lib/server/env";
import type {
  AiChangedFile,
  EditMode,
  EditPlan,
  SelectionPayload,
  SelectionTarget,
} from "@/lib/types";
import type { ContextFile } from "@/lib/server/anthropic";

const changedFileSchema = z.object({
  path: z.string().default(""),
  content: z.string(),
  reason: z.string().nullable(),
});

const patchOperationSchema = z.object({
  path: z.string().default(""),
  search: z.string().min(1),
  replace: z.string(),
  reason: z.string().nullable(),
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

const aiJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "warnings", "changedFiles"],
  properties: {
    summary: {
      type: "string",
      minLength: 1,
    },
    warnings: {
      type: "array",
      items: {
        type: "string",
      },
    },
    changedFiles: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "content", "reason"],
        properties: {
          path: {
            type: "string",
          },
          content: {
            type: "string",
          },
          reason: {
            type: ["string", "null"],
          },
        },
      },
    },
  },
} as const;

const aiPatchJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "warnings", "operations"],
  properties: {
    summary: {
      type: "string",
      minLength: 1,
    },
    warnings: {
      type: "array",
      items: {
        type: "string",
      },
    },
    operations: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "search", "replace", "reason"],
        properties: {
          path: {
            type: "string",
          },
          search: {
            type: "string",
            minLength: 1,
          },
          replace: {
            type: "string",
          },
          reason: {
            type: ["string", "null"],
          },
        },
      },
    },
  },
} as const;

function getOpenAiClient(): OpenAI {
  const { openaiApiKey } = getEnv();
  if (!openaiApiKey) {
    throw new Error("OPENAI_API_KEY is not configured.");
  }

  return new OpenAI({ apiKey: openaiApiKey });
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
      throw new Error("OpenAI did not specify which file to update.");
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
      throw new Error("OpenAI did not specify which file to patch.");
    }

    return {
      path: normalizedPath,
      search: operation.search,
      replace: operation.replace,
      ...(operation.reason ? { reason: operation.reason } : {}),
    };
  });
}

function buildCommonContent(params: {
  prompt: string;
  editMode: EditMode;
  selection: SelectionPayload | null;
  selectionTarget: SelectionTarget | null;
  editPlan: EditPlan;
  contextFiles: ContextFile[];
  attachments: ProcessedAttachment[];
  currentFilePath?: string;
  contextSummary?: string | null;
  guidelinesText?: string | null;
  projectMemoryText?: string | null;
  conversationHistoryText?: string | null;
  currentStateText?: string | null;
  activeKitSummaries?: string[];
}) {
  const content: Array<
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } }
  > = [
    {
      type: "text",
      text: [
        `User prompt: ${params.prompt}`,
        ...(params.guidelinesText ? [`Design system guidelines:\n${params.guidelinesText}`] : []),
        ...(params.projectMemoryText ? [`Project memory:\n${params.projectMemoryText}`] : []),
        ...(params.currentStateText ? [`Current design state:\n${params.currentStateText}`] : []),
        ...(params.conversationHistoryText
          ? [`Managed conversation history:\n${params.conversationHistoryText}`]
          : []),
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

  const attachmentPrompt = formatProcessedAttachmentsForPrompt(params.attachments);
  if (attachmentPrompt) {
    content.push({
      type: "text",
      text: attachmentPrompt,
    });
  }

  for (const attachment of collectProcessedAttachmentImages(params.attachments)) {
    if (attachment.mimeType.startsWith("image/")) {
      content.push({
        type: "image_url",
        image_url: {
          url: `data:${attachment.mimeType};base64,${attachment.data.toString("base64")}`,
        },
      });
    }
  }

  return content;
}

export async function requestOpenAiEdit(params: {
  model: string;
  prompt: string;
  editMode: EditMode;
  selection: SelectionPayload | null;
  selectionTarget: SelectionTarget | null;
  editPlan: EditPlan;
  currentFilePath?: string;
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
  changedFiles: AiChangedFile[];
  rawResponse: string | null;
}> {
  const client = getOpenAiClient();

  const systemPrompt = [
    "You are MyMake, an expert UI editor that updates uploaded React frontend code.",
    "Return only JSON that matches the provided schema.",
    "Always return full file contents for every changed file.",
    "Prefer minimal, local edits that preserve the project architecture.",
    "Do not reference files that are not included in changedFiles.",
    "Do not rename files, change relative import paths, or change export/import symbol names unless the user explicitly asks for that refactor.",
    "Preserve existing file paths and module wiring by default.",
    "Keep Tailwind and existing styling conventions intact unless the prompt explicitly asks for a larger redesign.",
    "Treat the provided edit plan and semantic target as hard constraints unless the prompt explicitly broadens the scope.",
    "Read the provided design system guidelines, project memory, managed conversation history, and current state summary before making changes.",
    ...(isStaticOverrideContext(params) ? staticOverrideInstructions() : []),
  ].join("\n");

  const response = await client.chat.completions.create({
    model: params.model,
    messages: [
      {
        role: "system",
        content: systemPrompt,
      },
      {
        role: "user",
        content: buildCommonContent(params),
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "my_make_ai_edit",
        strict: true,
        schema: aiJsonSchema,
      },
    },
  });

  const responseText = response.choices[0]?.message?.content;
  if (!responseText) {
    throw new Error("OpenAI returned an empty response for this edit request.");
  }

  const parsed = aiResponseSchema.parse(JSON.parse(responseText));

  return {
    ...parsed,
    changedFiles: normalizeChangedFiles(parsed.changedFiles, params.currentFilePath),
    rawResponse: responseText,
  };
}

export async function requestOpenAiPatchEdit(params: {
  model: string;
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
  const client = getOpenAiClient();
  const allowedPaths = Array.from(
    new Set([params.currentFilePath, ...params.contextFiles.map((file) => file.path)]),
  );

  const systemPrompt = [
    "You are MyMake, an expert UI editor that updates uploaded frontend code.",
    "The active file is too large to rewrite in full.",
    "Return only JSON that matches the provided schema.",
    "Produce precise search/replace operations instead of full file rewrites.",
    "Each operations.path must exactly match one of the allowed file paths.",
    "Each search value must be copied exactly from the provided source snippets.",
    "Prefer 1-3 targeted operations.",
    "Use an empty string in replace when the user wants content removed.",
    "Honor the provided edit plan and semantic target when choosing search/replace operations.",
    "Read the provided design system guidelines, project memory, managed conversation history, and current state summary before deciding the patch.",
  ].join("\n");

  const response = await client.chat.completions.create({
    model: params.model,
    messages: [
      {
        role: "system",
        content: systemPrompt,
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `Allowed file paths: ${allowedPaths.join(", ")}`,
          },
          ...buildCommonContent(params),
        ],
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "my_make_ai_patch_edit",
        strict: true,
        schema: aiPatchJsonSchema,
      },
    },
  });

  const responseText = response.choices[0]?.message?.content;
  if (!responseText) {
    throw new Error("OpenAI returned an empty response for this edit request.");
  }

  const parsed = aiPatchResponseSchema.parse(JSON.parse(responseText));

  return {
    ...parsed,
    operations: normalizePatchOperations(parsed.operations, params.currentFilePath),
    rawResponse: responseText,
  };
}
