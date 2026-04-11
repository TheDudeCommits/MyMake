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
  reason: z.string().optional(),
});

const aiResponseSchema = z.object({
  summary: z.string().min(1),
  warnings: z.array(z.string()).default([]),
  changedFiles: z.array(changedFileSchema).min(1),
});

const aiJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "warnings", "changedFiles"],
  properties: {
    summary: {
      type: "string",
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
        required: ["path", "content"],
        properties: {
          path: {
            type: "string",
          },
          content: {
            type: "string",
          },
          reason: {
            type: "string",
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
    "Keep Tailwind and existing styling conventions intact unless the prompt explicitly asks for a larger redesign.",
  ].join("\n");

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

  const response = await client.chat.completions.create({
    model: params.model,
    messages: [
      {
        role: "system",
        content: systemPrompt,
      },
      {
        role: "user",
        content,
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

  return aiResponseSchema.parse(JSON.parse(responseText));
}
