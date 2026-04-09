import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

import { getEnv } from "@/lib/server/env";
import type {
  AiChangedFile,
  AnthropicAttachment,
  SelectionPayload,
} from "@/lib/types";

const aiResponseSchema = z.object({
  summary: z.string().min(1),
  warnings: z.array(z.string()).default([]),
  changedFiles: z
    .array(
      z.object({
        path: z.string().min(1),
        content: z.string(),
        reason: z.string().optional(),
      }),
    )
    .min(1),
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

function extractJsonFromText(value: string): unknown {
  const trimmed = value.trim();
  const withoutFence = trimmed
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "");

  return JSON.parse(withoutFence);
}

export async function requestAiEdit(params: {
  prompt: string;
  selection: SelectionPayload | null;
  contextFiles: ContextFile[];
  attachments: AnthropicAttachment[];
}): Promise<{
  summary: string;
  warnings: string[];
  changedFiles: AiChangedFile[];
}> {
  const client = getAnthropicClient();

  const systemPrompt = [
    "You are MyMake, an expert UI editor that updates uploaded React frontend code.",
    "Return JSON only.",
    'Use this exact shape: {"summary":"...", "warnings":["..."], "changedFiles":[{"path":"relative/path.tsx","content":"full file contents","reason":"optional"}]}',
    "Always return full file contents for every changed file.",
    "Prefer minimal, local edits that preserve the project architecture.",
    "Do not reference files that are not included in changedFiles.",
    "Keep Tailwind and existing styling conventions intact unless the prompt explicitly asks for a larger redesign.",
  ].join("\n");

  const contentBlocks: Anthropic.Messages.ContentBlockParam[] = [
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

  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 4096,
    system: systemPrompt,
    messages: [
      {
        role: "user",
        content: contentBlocks,
      },
    ],
  });

  const responseText = response.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");

  const parsed = aiResponseSchema.parse(extractJsonFromText(responseText));
  return parsed;
}
