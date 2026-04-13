import path from "node:path";

import type {
  GetFileResponse,
  GetLocalVariablesResponse,
} from "@figma/rest-api-spec/dist/api_types";
import { PDFParse } from "pdf-parse";
import sharp from "sharp";

import {
  serializeFigmaDesignContext,
  type FileResponse,
} from "@/lib/figma/design-context-serializer";
import { TokenCounter } from "@/lib/server/conversation-history";

const MAX_ATTACHMENTS = 10;
const DEFAULT_TOKEN_BUDGET = 8_000;
const FIGMA_SEMANTIC_TOKEN_LIMIT = 6_000;
const MAX_TEXT_FILE_BYTES = 1_000_000;
const MAX_IMAGE_SIDE = 1024;
const IMAGE_DOWNSAMPLE_STEPS = [1024, 768, 512, 384];

const TEXT_EXTENSIONS = new Map<string, string>([
  [".tsx", "tsx"],
  [".ts", "ts"],
  [".js", "js"],
  [".jsx", "jsx"],
  [".html", "html"],
  [".css", "css"],
  [".md", "markdown"],
  [".svg", "xml"],
  [".csv", "csv"],
  [".json", "json"],
  [".txt", "text"],
]);

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif"]);
const IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/gif"]);

export type ProcessedAttachmentKind =
  | "figma-design"
  | "image"
  | "text-file"
  | "pdf-text"
  | "pdf-images"
  | "error";

export interface ProcessedAttachmentImage {
  mimeType: string;
  data: Buffer;
  width: number;
  height: number;
  aspectRatio: number;
  fileSize: number;
  tokenEstimate: number;
}

export interface ProcessedAttachment {
  id: string;
  filename: string;
  mimeType: string;
  kind: ProcessedAttachmentKind;
  promptText: string;
  tokenEstimate: number;
  metadata: Record<string, unknown>;
  warnings: string[];
  images: ProcessedAttachmentImage[];
  error?: string;
}

export interface AttachmentValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export interface StoredAttachmentInput {
  kind: "stored";
  id: string;
  filename: string;
  mimeType: string;
  data: Buffer;
}

export interface FigmaDesignAttachmentInput {
  kind: "figma-design";
  id?: string;
  name?: string;
  url?: string;
  fileKey?: string;
  nodeId?: string;
  figmaToken: string;
}

export type AttachmentSourceInput = StoredAttachmentInput | FigmaDesignAttachmentInput;

interface PdfParserLike {
  getText(params?: Record<string, unknown>): Promise<{ text: string }>;
  getScreenshot(params?: Record<string, unknown>): Promise<{
    pages: Array<{
      data: Uint8Array;
      width: number;
      height: number;
      pageNumber: number;
    }>;
  }>;
  destroy?(): Promise<void>;
}

interface AttachmentManagerOptions {
  tokenBudget?: number;
  tokenCounter?: TokenCounter;
  fetchImpl?: typeof fetch;
  pdfParserFactory?: (data: Buffer) => PdfParserLike;
}

export class AttachmentManager {
  private readonly tokenBudget: number;
  private readonly tokenCounter: TokenCounter;
  private readonly fetchImpl: typeof fetch;
  private readonly pdfParserFactory: (data: Buffer) => PdfParserLike;

  constructor(options: AttachmentManagerOptions = {}) {
    this.tokenBudget = options.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
    this.tokenCounter = options.tokenCounter ?? new TokenCounter();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.pdfParserFactory =
      options.pdfParserFactory ??
      ((data) => new PDFParse({ data }) as unknown as PdfParserLike);
  }

  validate(files: File[]): AttachmentValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (files.length > MAX_ATTACHMENTS) {
      errors.push(`You can attach up to ${MAX_ATTACHMENTS} files at a time.`);
    }

    for (const file of files) {
      const extension = getLowerExtension(file.name);
      const isText = isTextAttachment(file.name, file.type);
      const isImage = isImageAttachment(file.name, file.type);
      const isPdf = isPdfAttachment(file.name, file.type);

      if (!isText && !isImage && !isPdf) {
        errors.push(
          `${file.name} is not a supported attachment type. Supported types are images, PDF, and text/code files.`,
        );
        continue;
      }

      if (isText && file.size > MAX_TEXT_FILE_BYTES) {
        errors.push(`${file.name} exceeds the 1MB limit for text/code attachments.`);
      }

      if (extension === ".svg") {
        warnings.push(`${file.name} will be treated as SVG source code, not as a raster image.`);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  async process(files: File[]): Promise<ProcessedAttachment[]> {
    const sources = await Promise.all(
      files.map(async (file) => ({
        kind: "stored" as const,
        id: file.name,
        filename: file.name,
        mimeType: file.type || inferMimeTypeFromExtension(file.name),
        data: Buffer.from(await file.arrayBuffer()),
      })),
    );

    return this.processSources(sources);
  }

  async processSources(sources: AttachmentSourceInput[]): Promise<ProcessedAttachment[]> {
    const processed = await Promise.all(
      sources.map(async (source) => {
        try {
          if (source.kind === "figma-design") {
            return await this.processFigmaDesignAttachment(source);
          }
          return await this.processStoredAttachment(source);
        } catch (error) {
          return {
            id: source.kind === "figma-design" ? source.id ?? source.nodeId ?? source.fileKey ?? "figma" : source.id,
            filename:
              source.kind === "figma-design"
                ? source.name ?? source.url ?? source.nodeId ?? "Figma design"
                : source.filename,
            mimeType:
              source.kind === "figma-design" ? "application/vnd.figma.design" : source.mimeType,
            kind: "error",
            promptText: "",
            tokenEstimate: 0,
            metadata: {},
            warnings: [],
            images: [],
            error:
              error instanceof Error ? error.message : "This attachment could not be processed.",
          } satisfies ProcessedAttachment;
        }
      }),
    );

    const successful = processed.filter((item) => item.kind !== "error");
    const budgeted = await this.enforceTokenBudget(successful);
    const budgetedMap = new Map(budgeted.map((item) => [item.id, item]));

    return processed.map((item) => budgetedMap.get(item.id) ?? item);
  }

  formatForPrompt(processed: ProcessedAttachment[]): string {
    return formatProcessedAttachmentsForPrompt(processed);
  }

  estimateTokens(processed: ProcessedAttachment[]): number {
    return processed.reduce((total, attachment) => total + attachment.tokenEstimate, 0);
  }

  private async processStoredAttachment(
    source: StoredAttachmentInput,
  ): Promise<ProcessedAttachment> {
    if (isImageAttachment(source.filename, source.mimeType)) {
      return this.processImageAttachment({
        id: source.id,
        filename: source.filename,
        mimeType: source.mimeType,
        data: source.data,
      });
    }

    if (isPdfAttachment(source.filename, source.mimeType)) {
      return this.processPdfAttachment({
        id: source.id,
        filename: source.filename,
        mimeType: source.mimeType,
        data: source.data,
      });
    }

    if (isTextAttachment(source.filename, source.mimeType)) {
      return this.processTextAttachment({
        id: source.id,
        filename: source.filename,
        mimeType: source.mimeType,
        data: source.data,
      });
    }

    throw new Error("Unsupported attachment type.");
  }

  private async processFigmaDesignAttachment(
    source: FigmaDesignAttachmentInput,
  ): Promise<ProcessedAttachment> {
    const reference = resolveFigmaReference(source);
    const headers = {
      "X-Figma-Token": source.figmaToken,
    };

    const [fileResponse, variablesResponse] = await Promise.all([
      this.fetchImpl(`https://api.figma.com/v1/files/${reference.fileKey}`, { headers }),
      this.fetchImpl(`https://api.figma.com/v1/files/${reference.fileKey}/variables/local`, {
        headers,
      }),
    ]);

    if (!fileResponse.ok) {
      throw new Error(`Could not fetch the Figma file (${fileResponse.status}).`);
    }

    const file = (await fileResponse.json()) as GetFileResponse;
    const localVariables = variablesResponse.ok
      ? ((await variablesResponse.json()) as GetLocalVariablesResponse)
      : null;

    const serialized = serializeFigmaDesignContext(file as FileResponse, reference.nodeId, {
      localVariables,
    });

    const variableSummary =
      Object.keys(serialized.variables).length > 0
        ? [
            "",
            "Bound variables:",
            "```json",
            JSON.stringify(serialized.variables, null, 2),
            "```",
          ].join("\n")
        : "";

    if (serialized.tokenEstimates.semantic > FIGMA_SEMANTIC_TOKEN_LIMIT) {
      const screenshotAttachment = await this.fetchFigmaScreenshot(
        reference,
        source.figmaToken,
        source.name ?? `Figma ${reference.nodeId}`,
      );
      screenshotAttachment.warnings.push(
        `Semantic serialization exceeded ${FIGMA_SEMANTIC_TOKEN_LIMIT} tokens, so MyMake fell back to screenshot mode.`,
      );
      return screenshotAttachment;
    }

    const promptText = [
      "Structural representation preserving auto-layout, hierarchy, component names, variant states, and token bindings:",
      "```jsx",
      serialized.semantic,
      "```",
      variableSummary,
    ]
      .filter(Boolean)
      .join("\n");

    return {
      id: source.id ?? `${reference.fileKey}:${reference.nodeId}`,
      filename: source.name ?? `Figma ${reference.nodeId}`,
      mimeType: "application/vnd.figma.design",
      kind: "figma-design",
      promptText,
      tokenEstimate: this.tokenCounter.countText(promptText),
      metadata: {
        fileKey: reference.fileKey,
        nodeId: reference.nodeId,
        tokenEstimate: serialized.tokenEstimates.semantic,
      },
      warnings: [...serialized.warnings],
      images: [],
    };
  }

  private async fetchFigmaScreenshot(
    reference: { fileKey: string; nodeId: string },
    figmaToken: string,
    label: string,
  ): Promise<ProcessedAttachment> {
    const imageResponse = await this.fetchImpl(
      `https://api.figma.com/v1/images/${reference.fileKey}?ids=${encodeURIComponent(reference.nodeId)}&format=png&scale=1`,
      {
        headers: {
          "X-Figma-Token": figmaToken,
        },
      },
    );

    if (!imageResponse.ok) {
      throw new Error(`Could not fetch a Figma screenshot (${imageResponse.status}).`);
    }

    const imagePayload = (await imageResponse.json()) as {
      images?: Record<string, string>;
    };
    const imageUrl = imagePayload.images?.[reference.nodeId];
    if (!imageUrl) {
      throw new Error("Figma did not return a screenshot URL for the requested node.");
    }

    const binaryResponse = await this.fetchImpl(imageUrl);
    if (!binaryResponse.ok) {
      throw new Error(`Could not download the Figma screenshot (${binaryResponse.status}).`);
    }

    return this.processImageAttachment({
      id: `${reference.fileKey}:${reference.nodeId}:screenshot`,
      filename: `${label}.png`,
      mimeType: "image/png",
      data: Buffer.from(await binaryResponse.arrayBuffer()),
    });
  }

  private async processImageAttachment(input: {
    id: string;
    filename: string;
    mimeType: string;
    data: Buffer;
  }): Promise<ProcessedAttachment> {
    const resized = await resizeImageBuffer(input.data, MAX_IMAGE_SIDE);
    const promptText = [
      "Visual reference image attached.",
      `Original size: ${resized.originalWidth}x${resized.originalHeight}`,
      `Processed size: ${resized.width}x${resized.height}`,
      `Aspect ratio: ${resized.aspectRatio.toFixed(3)}`,
      `File size: ${formatBytes(resized.originalSizeBytes)}`,
    ].join("\n");

    return {
      id: input.id,
      filename: input.filename,
      mimeType: input.mimeType,
      kind: "image",
      promptText,
      tokenEstimate: this.tokenCounter.countText(promptText) + resized.tokenEstimate,
      metadata: {
        originalWidth: resized.originalWidth,
        originalHeight: resized.originalHeight,
        width: resized.width,
        height: resized.height,
        aspectRatio: resized.aspectRatio,
        originalSizeBytes: resized.originalSizeBytes,
        processedSizeBytes: resized.buffer.byteLength,
      },
      warnings: [],
      images: [
        {
          mimeType: "image/png",
          data: resized.buffer,
          width: resized.width,
          height: resized.height,
          aspectRatio: resized.aspectRatio,
          fileSize: resized.buffer.byteLength,
          tokenEstimate: resized.tokenEstimate,
        },
      ],
    };
  }

  private async processTextAttachment(input: {
    id: string;
    filename: string;
    mimeType: string;
    data: Buffer;
  }): Promise<ProcessedAttachment> {
    const extension = getLowerExtension(input.filename);
    const language = TEXT_EXTENSIONS.get(extension) ?? "text";
    const rawText = input.data.toString("utf8");

    let promptText = "";
    let metadata: Record<string, unknown> = {
      language,
      sizeBytes: input.data.byteLength,
    };

    if (extension === ".csv") {
      const preview = buildCsvPreview(rawText);
      promptText = [
        "CSV preview (headers + first 5 rows):",
        "```csv",
        preview.previewCsv,
        "```",
        "",
        "Full CSV data:",
        "```csv",
        rawText,
        "```",
      ].join("\n");
      metadata = {
        ...metadata,
        headers: preview.headers,
        previewRows: preview.rows,
        previewCsv: preview.previewCsv,
        fullText: rawText,
      };
    } else if (extension === ".json") {
      const preview = buildJsonPreview(rawText);
      promptText = [
        "JSON preview (depth limited to 3):",
        "```json",
        preview.preview,
        "```",
        "",
        "Full JSON:",
        "```json",
        preview.full,
        "```",
      ].join("\n");
      metadata = {
        ...metadata,
        previewDepth: 3,
        previewJson: preview.preview,
        fullText: preview.full,
      };
    } else {
      promptText = [
        `Text/code attachment (${language}):`,
        `\`\`\`${language}`,
        rawText,
        "```",
      ].join("\n");
      metadata = {
        ...metadata,
        fullText: rawText,
      };
    }

    return {
      id: input.id,
      filename: input.filename,
      mimeType: input.mimeType,
      kind: "text-file",
      promptText,
      tokenEstimate: this.tokenCounter.countText(promptText),
      metadata,
      warnings: [],
      images: [],
    };
  }

  private async processPdfAttachment(input: {
    id: string;
    filename: string;
    mimeType: string;
    data: Buffer;
  }): Promise<ProcessedAttachment> {
    const parser = this.pdfParserFactory(input.data);
    try {
      const textResult = await parser.getText({
        parseHyperlinks: true,
        first: 20,
      });

      if (textResult.text.trim()) {
        const promptText = [
          "Extracted PDF text:",
          "```text",
          textResult.text.trim(),
          "```",
        ].join("\n");

        return {
          id: input.id,
          filename: input.filename,
          mimeType: input.mimeType,
          kind: "pdf-text",
          promptText,
          tokenEstimate: this.tokenCounter.countText(promptText),
          metadata: {
            pagesExtracted: "total" in textResult ? Number(textResult.total) : undefined,
          },
          warnings: [],
          images: [],
        };
      }
    } catch {
      // fall through to screenshot mode
    }

    try {
      const screenshots = await parser.getScreenshot({
        first: 3,
        desiredWidth: MAX_IMAGE_SIDE,
        imageBuffer: true,
        imageDataUrl: false,
      });
      const images: ProcessedAttachmentImage[] = [];

      for (const page of screenshots.pages) {
        const resized = await resizeImageBuffer(Buffer.from(page.data), MAX_IMAGE_SIDE);
        images.push({
          mimeType: "image/png",
          data: resized.buffer,
          width: resized.width,
          height: resized.height,
          aspectRatio: resized.aspectRatio,
          fileSize: resized.buffer.byteLength,
          tokenEstimate: resized.tokenEstimate,
        });
      }

      const promptText = [
        "PDF text extraction failed, so this document is attached as page images.",
        `Pages rendered: ${images.length}`,
      ].join("\n");

      return {
        id: input.id,
        filename: input.filename,
        mimeType: input.mimeType,
        kind: "pdf-images",
        promptText,
        tokenEstimate:
          this.tokenCounter.countText(promptText) +
          images.reduce((total, image) => total + image.tokenEstimate, 0),
        metadata: {
          renderedPages: images.length,
        },
        warnings: ["PDF text extraction failed; MyMake fell back to page screenshots."],
        images,
      };
    } finally {
      await parser.destroy?.().catch(() => undefined);
    }
  }

  private async enforceTokenBudget(
    processed: ProcessedAttachment[],
  ): Promise<ProcessedAttachment[]> {
    const attachments = processed.map((attachment) => cloneProcessedAttachment(attachment));

    while (this.estimateTokens(attachments) > this.tokenBudget) {
      const candidate = [...attachments]
        .sort((left, right) => right.tokenEstimate - left.tokenEstimate)
        .find((attachment) => canDownsampleAttachment(attachment));

      if (!candidate) {
        break;
      }

      await this.downsampleAttachment(candidate);
      candidate.warnings.push(
        `Downsampled to stay within the ${this.tokenBudget}-token attachment budget.`,
      );
    }

    return attachments;
  }

  private async downsampleAttachment(attachment: ProcessedAttachment): Promise<void> {
    if (attachment.kind === "text-file") {
      const extension = getLowerExtension(attachment.filename);
      if (extension === ".csv" && typeof attachment.metadata.fullText === "string") {
        attachment.promptText = [
          "CSV preview only (full data truncated for budget):",
          "```csv",
          String(attachment.metadata.previewCsv ?? ""),
          "```",
        ].join("\n");
      } else if (extension === ".json" && typeof attachment.metadata.previewJson === "string") {
        attachment.promptText = [
          "JSON preview only (full data truncated for budget):",
          "```json",
          String(attachment.metadata.previewJson),
          "```",
        ].join("\n");
      } else {
        attachment.promptText = summarizeTextForBudget(
          String(attachment.promptText),
          this.tokenCounter,
        );
      }
      attachment.tokenEstimate = this.tokenCounter.countText(attachment.promptText);
      return;
    }

    if (attachment.kind === "pdf-text" || attachment.kind === "figma-design") {
      attachment.promptText = summarizeTextForBudget(
        attachment.promptText,
        this.tokenCounter,
      );
      attachment.tokenEstimate =
        this.tokenCounter.countText(attachment.promptText) +
        attachment.images.reduce((total, image) => total + image.tokenEstimate, 0);
      return;
    }

    if (
      (attachment.kind === "image" || attachment.kind === "pdf-images") &&
      attachment.images.length > 0
    ) {
      const nextMaxSide = nextImageDownsampleSize(attachment.images[0].width, attachment.images[0].height);
      if (!nextMaxSide) {
        return;
      }

      const resizedImages = await Promise.all(
        attachment.images.map(async (image) => {
          const resized = await resizeImageBuffer(image.data, nextMaxSide);
          return {
            mimeType: "image/png",
            data: resized.buffer,
            width: resized.width,
            height: resized.height,
            aspectRatio: resized.aspectRatio,
            fileSize: resized.buffer.byteLength,
            tokenEstimate: resized.tokenEstimate,
          } satisfies ProcessedAttachmentImage;
        }),
      );
      attachment.images = resizedImages;
      attachment.tokenEstimate =
        this.tokenCounter.countText(attachment.promptText) +
        resizedImages.reduce((total, image) => total + image.tokenEstimate, 0);
    }
  }
}

export function formatProcessedAttachmentsForPrompt(
  processed: ProcessedAttachment[],
): string {
  return processed
    .map((attachment, index) => {
      const label = attachmentLabel(attachment);
      const warningBlock = attachment.warnings.length
        ? `Warnings:\n- ${attachment.warnings.join("\n- ")}\n`
        : "";
      const errorBlock = attachment.error ? `Error: ${attachment.error}\n` : "";

      return [
        `=== ATTACHMENT ${index + 1}: ${label} ===`,
        errorBlock,
        warningBlock,
        attachment.promptText,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}

export function collectProcessedAttachmentImages(
  processed: ProcessedAttachment[],
): ProcessedAttachmentImage[] {
  return processed.flatMap((attachment) => attachment.images);
}

function attachmentLabel(attachment: ProcessedAttachment): string {
  switch (attachment.kind) {
    case "figma-design":
      return `Figma Design '${attachment.filename}'`;
    case "image":
      return `Image '${attachment.filename}'`;
    case "text-file":
      return `Text File '${attachment.filename}'`;
    case "pdf-text":
    case "pdf-images":
      return `PDF '${attachment.filename}'`;
    default:
      return `Attachment '${attachment.filename}'`;
  }
}

function cloneProcessedAttachment(attachment: ProcessedAttachment): ProcessedAttachment {
  return {
    ...attachment,
    metadata: { ...attachment.metadata },
    warnings: [...attachment.warnings],
    images: attachment.images.map((image) => ({ ...image, data: Buffer.from(image.data) })),
  };
}

function canDownsampleAttachment(attachment: ProcessedAttachment): boolean {
  if (attachment.kind === "text-file") {
    return true;
  }

  if (attachment.kind === "figma-design" || attachment.kind === "pdf-text") {
    return attachment.tokenEstimate > 300;
  }

  if (attachment.kind === "image" || attachment.kind === "pdf-images") {
    return attachment.images.some((image) => nextImageDownsampleSize(image.width, image.height));
  }

  return false;
}

function nextImageDownsampleSize(width: number, height: number): number | null {
  const longest = Math.max(width, height);
  for (const step of IMAGE_DOWNSAMPLE_STEPS) {
    if (step < longest) {
      return step;
    }
  }
  return null;
}

async function resizeImageBuffer(
  data: Buffer,
  maxSide: number,
): Promise<{
  buffer: Buffer;
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
  aspectRatio: number;
  originalSizeBytes: number;
  tokenEstimate: number;
}> {
  const input = sharp(data, { animated: true }).rotate();
  const metadata = await input.metadata();
  const originalWidth = metadata.width ?? maxSide;
  const originalHeight = metadata.height ?? maxSide;

  const buffer = await input
    .resize({
      width: maxSide,
      height: maxSide,
      fit: "inside",
      withoutEnlargement: true,
    })
    .png()
    .toBuffer();

  const resizedMeta = await sharp(buffer).metadata();
  const width = resizedMeta.width ?? originalWidth;
  const height = resizedMeta.height ?? originalHeight;

  return {
    buffer,
    width,
    height,
    originalWidth,
    originalHeight,
    aspectRatio: width / Math.max(height, 1),
    originalSizeBytes: data.byteLength,
    tokenEstimate: estimateImageTokens(width, height),
  };
}

function estimateImageTokens(width: number, height: number): number {
  const tiles = Math.ceil(width / 512) * Math.ceil(height / 512);
  return Math.max(85, tiles * 170);
}

function buildCsvPreview(value: string): {
  headers: string[];
  rows: string[][];
  previewCsv: string;
} {
  const rows = parseCsv(value);
  const headers = rows[0] ?? [];
  const previewRows = rows.slice(1, 6);
  const previewCsv = [headers, ...previewRows]
    .filter((row) => row.length > 0)
    .map((row) => row.join(","))
    .join("\n");

  return {
    headers,
    rows: previewRows,
    previewCsv,
  };
}

function parseCsv(value: string): string[][] {
  const rows: string[][] = [];
  let currentCell = "";
  let currentRow: string[] = [];
  let inQuotes = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    const next = value[index + 1];

    if (char === "\"") {
      if (inQuotes && next === "\"") {
        currentCell += "\"";
        index += 1;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }

    if (!inQuotes && char === ",") {
      currentRow.push(currentCell);
      currentCell = "";
      continue;
    }

    if (!inQuotes && (char === "\n" || char === "\r")) {
      if (char === "\r" && next === "\n") {
        index += 1;
      }
      currentRow.push(currentCell);
      rows.push(currentRow);
      currentCell = "";
      currentRow = [];
      continue;
    }

    currentCell += char;
  }

  if (currentCell.length > 0 || currentRow.length > 0) {
    currentRow.push(currentCell);
    rows.push(currentRow);
  }

  return rows;
}

function buildJsonPreview(value: string): { preview: string; full: string } {
  try {
    const parsed = JSON.parse(value) as unknown;
    return {
      preview: JSON.stringify(limitJsonDepth(parsed, 3), null, 2),
      full: JSON.stringify(parsed, null, 2),
    };
  } catch {
    return {
      preview: value,
      full: value,
    };
  }
}

function limitJsonDepth(value: unknown, depth: number): unknown {
  if (depth <= 0) {
    if (Array.isArray(value)) {
      return `[Array(${value.length})]`;
    }
    if (value && typeof value === "object") {
      return "[Object]";
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 10).map((entry) => limitJsonDepth(entry, depth - 1));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).slice(0, 20).map(([key, entry]) => [
        key,
        limitJsonDepth(entry, depth - 1),
      ]),
    );
  }

  return value;
}

function summarizeTextForBudget(text: string, tokenCounter: TokenCounter): string {
  const lines = text.split("\n").filter(Boolean);
  const preview = [...lines.slice(0, 18), "...", ...lines.slice(-6)].join("\n");
  return tokenCounter.truncateText(
    `Attachment summary (budget reduced):\n${preview}`,
    Math.max(250, Math.floor(tokenCounter.countText(text) * 0.45)),
  );
}

function resolveFigmaReference(source: FigmaDesignAttachmentInput): {
  fileKey: string;
  nodeId: string;
} {
  if (source.fileKey && source.nodeId) {
    return {
      fileKey: source.fileKey,
      nodeId: normalizeFigmaNodeId(source.nodeId),
    };
  }

  if (!source.url) {
    throw new Error("A Figma design attachment needs either a fileKey+nodeId pair or a Figma URL.");
  }

  const url = new URL(source.url);
  const match = url.pathname.match(/\/(?:design|file)\/([^/]+)/);
  const rawNodeId = url.searchParams.get("node-id");

  if (!match?.[1] || !rawNodeId) {
    throw new Error("Could not extract the Figma file key and node-id from the provided URL.");
  }

  return {
    fileKey: match[1],
    nodeId: normalizeFigmaNodeId(rawNodeId),
  };
}

function normalizeFigmaNodeId(value: string): string {
  return value.replace(/-/g, ":");
}

function getLowerExtension(filename: string): string {
  return path.extname(filename).toLowerCase();
}

function isTextAttachment(filename: string, mimeType: string): boolean {
  const extension = getLowerExtension(filename);
  if (TEXT_EXTENSIONS.has(extension)) {
    return true;
  }

  return (
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType === "image/svg+xml"
  );
}

function isImageAttachment(filename: string, mimeType: string): boolean {
  const extension = getLowerExtension(filename);
  return IMAGE_EXTENSIONS.has(extension) || IMAGE_MIME_TYPES.has(mimeType.toLowerCase());
}

function isPdfAttachment(filename: string, mimeType: string): boolean {
  return getLowerExtension(filename) === ".pdf" || mimeType === "application/pdf";
}

function inferMimeTypeFromExtension(filename: string): string {
  const extension = getLowerExtension(filename);
  if (extension === ".pdf") {
    return "application/pdf";
  }
  if (TEXT_EXTENSIONS.has(extension)) {
    return extension === ".svg" ? "image/svg+xml" : "text/plain";
  }
  if (extension === ".png") {
    return "image/png";
  }
  if (extension === ".gif") {
    return "image/gif";
  }
  if (extension === ".jpg" || extension === ".jpeg") {
    return "image/jpeg";
  }
  return "application/octet-stream";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
