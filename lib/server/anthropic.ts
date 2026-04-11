import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

import { getEnv } from "@/lib/server/env";
import type {
  AiChangedFile,
  AnthropicAttachment,
  SelectionPayload,
} from "@/lib/types";

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

export async function requestAiEdit(params: {
  model?: string;
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
    "Start the response immediately with { and end it immediately with }.",
    'Use this exact shape: {"summary":"...", "warnings":["..."], "changedFiles":[{"path":"relative/path.tsx","content":"full file contents","reason":"optional"}]}',
    "Always return full file contents for every changed file.",
    "Prefer minimal, local edits that preserve the project architecture.",
    "Do not reference files that are not included in changedFiles.",
    "Do not rename files, change relative import paths, or change export/import symbol names unless the user explicitly asks for that refactor.",
    "Preserve existing file paths and module wiring by default.",
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
    model: params.model || "claude-sonnet-4-20250514",
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

  const parsed = normalizeAiResponseShape(extractJsonFromText(responseText));
  return parsed;
}

export { requestAiEdit as requestAnthropicAiEdit };
