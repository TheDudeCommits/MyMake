import OpenAI from "openai";
import { z } from "zod";

import { getEnv } from "@/lib/server/env";
import type {
  AiChangedFile,
  AnthropicAttachment,
  SelectionPayload,
} from "@/lib/types";
import type { ContextFile } from "@/lib/server/anthropic";

const changedFileSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  reason: z.string().nullable(),
});

const patchOperationSchema = z.object({
  path: z.string().min(1),
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
            minLength: 1,
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
            minLength: 1,
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

function buildCommonContent(params: {
  prompt: string;
  selection: SelectionPayload | null;
  contextFiles: ContextFile[];
  attachments: AnthropicAttachment[];
  currentFilePath?: string;
}) {
  const content: Array<
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } }
  > = [
    {
      type: "text",
      text: [
        `User prompt: ${params.prompt}`,
        `Selected element: ${
          params.selection
            ? JSON.stringify(params.selection, null, 2)
            : "No element is currently selected."
        }`,
        ...(params.currentFilePath ? [`Active file: ${params.currentFilePath}`] : []),
        "Relevant source files:",
        ...params.contextFiles.map(
          (file) => `\n### ${file.path} (${file.reason})\n${file.content}`,
        ),
      ].join("\n"),
    },
  ];

  for (const attachment of params.attachments) {
    if (attachment.mimeType.startsWith("image/")) {
      content.push({
        type: "image_url",
        image_url: {
          url: `data:${attachment.mimeType};base64,${attachment.data.toString("base64")}`,
        },
      });
      content.push({
        type: "text",
        text: `Image attachment: ${attachment.filename}`,
      });
      continue;
    }

    content.push({
      type: "text",
      text: `Attachment ${attachment.filename} (${attachment.mimeType}):\n${attachment.data.toString("utf8").slice(0, 12_000)}`,
    });
  }

  return content;
}

export async function requestOpenAiEdit(params: {
  model: string;
  prompt: string;
  selection: SelectionPayload | null;
  contextFiles: ContextFile[];
  attachments: AnthropicAttachment[];
}): Promise<{
  summary: string;
  warnings: string[];
  changedFiles: AiChangedFile[];
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
    changedFiles: parsed.changedFiles.map((file) => ({
      path: file.path,
      content: file.content,
      ...(file.reason ? { reason: file.reason } : {}),
    })),
  };
}

export async function requestOpenAiPatchEdit(params: {
  model: string;
  prompt: string;
  selection: SelectionPayload | null;
  currentFilePath: string;
  contextFiles: ContextFile[];
  attachments: AnthropicAttachment[];
}): Promise<{
  summary: string;
  warnings: string[];
  operations: Array<{ path: string; search: string; replace: string; reason?: string }>;
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
    operations: parsed.operations.map((operation) => ({
      path: operation.path,
      search: operation.search,
      replace: operation.replace,
      ...(operation.reason ? { reason: operation.reason } : {}),
    })),
  };
}
