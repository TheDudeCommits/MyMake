import test from "node:test";
import assert from "node:assert/strict";

import type {
  GetFileResponse,
  GetLocalVariablesResponse,
} from "@figma/rest-api-spec/dist/api_types";
import sharp from "sharp";

import {
  AttachmentManager,
  type StoredAttachmentInput,
} from "@/lib/server/attachment-manager";

function createFigmaFileResponse(text = "Login title"): GetFileResponse {
  return {
    document: {
      id: "0:0",
      name: "Document",
      type: "DOCUMENT",
      visible: true,
      locked: false,
      scrollBehavior: "SCROLLS",
      children: [
        {
          id: "1:0",
          name: "Page",
          type: "CANVAS",
          visible: true,
          locked: false,
          scrollBehavior: "SCROLLS",
          backgroundColor: { r: 1, g: 1, b: 1, a: 1 },
          prototypeStartNodeID: null,
          flowStartingPoints: [],
          prototypeDevice: { type: "NONE", rotation: "NONE" },
          exportSettings: [],
          children: [
            {
              id: "2:0",
              name: "Login Screen",
              type: "FRAME",
              visible: true,
              locked: false,
              scrollBehavior: "SCROLLS",
              absoluteBoundingBox: { x: 0, y: 0, width: 390, height: 844 },
              absoluteRenderBounds: { x: 0, y: 0, width: 390, height: 844 },
              blendMode: "PASS_THROUGH",
              opacity: 1,
              layoutMode: "VERTICAL",
              primaryAxisAlignItems: "MIN",
              counterAxisAlignItems: "MIN",
              primaryAxisSizingMode: "AUTO",
              counterAxisSizingMode: "AUTO",
              paddingTop: 24,
              paddingRight: 24,
              paddingBottom: 24,
              paddingLeft: 24,
              itemSpacing: 12,
              fills: [],
              strokes: [],
              effects: [],
              exportSettings: [],
              boundVariables: {
                itemSpacing: { type: "VARIABLE_ALIAS", id: "var-spacing-md" },
              },
              children: [
                {
                  id: "2:1",
                  name: "Title",
                  type: "TEXT",
                  visible: true,
                  locked: false,
                  scrollBehavior: "SCROLLS",
                  absoluteBoundingBox: { x: 24, y: 24, width: 240, height: 40 },
                  absoluteRenderBounds: { x: 24, y: 24, width: 240, height: 40 },
                  blendMode: "NORMAL",
                  opacity: 1,
                  exportSettings: [],
                  fills: [],
                  effects: [],
                  characters: text,
                  style: {
                    fontFamily: "Inter",
                    fontStyle: "Bold",
                    fontWeight: 700,
                    fontSize: 24,
                    fills: [
                      {
                        type: "SOLID",
                        visible: true,
                        opacity: 1,
                        blendMode: "NORMAL",
                        color: { r: 0.23, g: 0.51, b: 0.96, a: 1 },
                        boundVariables: {
                          color: { type: "VARIABLE_ALIAS", id: "var-color-primary" },
                        },
                      },
                    ],
                  },
                  characterStyleOverrides: [],
                  styleOverrideTable: {},
                  lineTypes: ["NONE"],
                  lineIndentations: [0],
                },
              ],
            },
          ],
        },
      ],
    },
    components: {},
    componentSets: {},
    styles: {},
    schemaVersion: 0,
    name: "Attachment test",
    role: "owner",
    lastModified: "2026-04-13T00:00:00.000Z",
    thumbnailUrl: "",
    version: "1",
    editorType: "figma",
  } as unknown as GetFileResponse;
}

function createLargeFigmaFileResponse(): GetFileResponse {
  const file = createFigmaFileResponse();
  const frame = file.document.children[0]!.children[0] as unknown as {
    children: Array<Record<string, unknown>>;
  };

  frame.children = Array.from({ length: 320 }, (_, index) => ({
    id: `2:${index + 1}`,
    name: `Copy ${index + 1}`,
    type: "TEXT",
    visible: true,
    locked: false,
    scrollBehavior: "SCROLLS",
    absoluteBoundingBox: { x: 24, y: 24 + index * 24, width: 300, height: 20 },
    absoluteRenderBounds: { x: 24, y: 24 + index * 24, width: 300, height: 20 },
    blendMode: "NORMAL",
    opacity: 1,
    exportSettings: [],
    fills: [],
    effects: [],
    characters: `This is a repeated semantic line ${index + 1} for token budget overflow testing.`,
    style: {
      fontFamily: "Inter",
      fontStyle: "Regular",
      fontWeight: 400,
      fontSize: 14,
      fills: [],
    },
    characterStyleOverrides: [],
    styleOverrideTable: {},
    lineTypes: ["NONE"],
    lineIndentations: [0],
  }));

  return file;
}

function createLocalVariables(): GetLocalVariablesResponse {
  return {
    status: 200,
    error: false,
    meta: {
      variables: {
        "var-spacing-md": {
          id: "var-spacing-md",
          key: "spacing-md",
          name: "spacing/md",
          variableCollectionId: "collection:core",
          resolvedType: "FLOAT",
          valuesByMode: {
            "mode:default": 16,
          },
          remote: false,
          description: "",
          hiddenFromPublishing: false,
          scopes: ["GAP"],
          codeSyntax: {},
        },
        "var-color-primary": {
          id: "var-color-primary",
          key: "color-primary",
          name: "color/primary",
          variableCollectionId: "collection:core",
          resolvedType: "COLOR",
          valuesByMode: {
            "mode:default": { r: 0.23, g: 0.51, b: 0.96, a: 1 },
          },
          remote: false,
          description: "",
          hiddenFromPublishing: false,
          scopes: ["TEXT_FILL"],
          codeSyntax: {},
        },
      },
      variableCollections: {},
    },
  } as unknown as GetLocalVariablesResponse;
}

async function createPngBuffer(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 24, g: 32, b: 48, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
}

test("validates attachment count and text file size limits", async () => {
  const manager = new AttachmentManager();
  const oversized = new File(["a".repeat(1_000_001)], "huge.txt", { type: "text/plain" });
  const manyFiles = Array.from({ length: 11 }, (_, index) =>
    new File([`file-${index}`], `sample-${index}.txt`, { type: "text/plain" }),
  );

  const validation = manager.validate([oversized, ...manyFiles]);

  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((error) => error.includes("up to 10 files")));
  assert.ok(validation.errors.some((error) => error.includes("1MB limit")));
});

test("processes CSV attachments and formats them for prompt injection", async () => {
  const manager = new AttachmentManager();
  const processed = await manager.process([
    new File(
      ["id,name\n1,Amir\n2,Sam\n3,Ava\n4,Noah\n5,Ella\n6,Leo"],
      "users.csv",
      { type: "text/csv" },
    ),
  ]);

  assert.equal(processed[0]?.kind, "text-file");
  assert.match(processed[0]?.promptText ?? "", /CSV preview/);
  assert.match(processed[0]?.promptText ?? "", /Full CSV data/);

  const prompt = manager.formatForPrompt(processed);
  assert.match(prompt, /=== ATTACHMENT 1: Text File 'users\.csv' ===/);
});

test("processes Figma design attachments into semantic context", async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("/variables/local")) {
      return new Response(JSON.stringify(createLocalVariables()), { status: 200 });
    }
    if (url.includes("/v1/files/")) {
      return new Response(JSON.stringify(createFigmaFileResponse("Welcome back")), {
        status: 200,
      });
    }
    throw new Error(`Unexpected fetch ${url}`);
  };

  const manager = new AttachmentManager({ fetchImpl });
  const [processed] = await manager.processSources([
    {
      kind: "figma-design",
      fileKey: "abc123",
      nodeId: "2:0",
      figmaToken: "token",
      name: "Login Screen",
    },
  ]);

  assert.equal(processed?.kind, "figma-design");
  assert.match(processed?.promptText ?? "", /Structural representation/);
  assert.match(processed?.promptText ?? "", /```jsx/);
  assert.match(processed?.promptText ?? "", /color\/primary/);
});

test("falls back to screenshot mode when Figma semantic output exceeds the token threshold", async () => {
  const screenshotBuffer = await createPngBuffer(1400, 900);
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("/variables/local")) {
      return new Response(JSON.stringify(createLocalVariables()), { status: 200 });
    }
    if (url.includes("/v1/files/")) {
      return new Response(JSON.stringify(createLargeFigmaFileResponse()), { status: 200 });
    }
    if (url.includes("/v1/images/")) {
      return new Response(
        JSON.stringify({
          images: {
            "2:0": "https://cdn.figma.test/frame.png",
          },
        }),
        { status: 200 },
      );
    }
    if (url === "https://cdn.figma.test/frame.png") {
      return new Response(screenshotBuffer, { status: 200 });
    }
    throw new Error(`Unexpected fetch ${url}`);
  };

  const manager = new AttachmentManager({ fetchImpl });
  const [processed] = await manager.processSources([
    {
      kind: "figma-design",
      fileKey: "overflow",
      nodeId: "2:0",
      figmaToken: "token",
      name: "Huge Frame",
    },
  ]);

  assert.equal(processed?.kind, "image");
  assert.ok(processed?.images.length);
  assert.ok(processed?.warnings.some((warning) => warning.includes("fell back to screenshot")));
});

test("falls back to PDF screenshots when text extraction fails", async () => {
  const screenshotBuffer = await createPngBuffer(900, 1200);
  const manager = new AttachmentManager({
    pdfParserFactory: () => ({
      async getText() {
        throw new Error("Extraction failed");
      },
      async getScreenshot() {
        return {
          pages: [
            {
              data: screenshotBuffer,
              width: 900,
              height: 1200,
              pageNumber: 1,
            },
          ],
        };
      },
      async destroy() {
        return;
      },
    }),
  });

  const [processed] = await manager.processSources([
    {
      kind: "stored",
      id: "pdf-1",
      filename: "brief.pdf",
      mimeType: "application/pdf",
      data: Buffer.from("fake pdf"),
    },
  ]);

  assert.equal(processed?.kind, "pdf-images");
  assert.ok(processed?.images.length);
  assert.ok(processed?.warnings.some((warning) => warning.includes("fell back")));
});

test("enforces the attachment token budget by downsampling oversized text attachments", async () => {
  const manager = new AttachmentManager({ tokenBudget: 350 });
  const largeText = "Line of context ".repeat(600);

  const [processed] = await manager.processSources([
    {
      kind: "stored",
      id: "txt-1",
      filename: "notes.txt",
      mimeType: "text/plain",
      data: Buffer.from(largeText, "utf8"),
    } satisfies StoredAttachmentInput,
  ]);

  assert.equal(processed?.kind, "text-file");
  assert.ok((processed?.tokenEstimate ?? 0) <= 350);
  assert.ok(processed?.warnings.some((warning) => warning.includes("Downsampled")));
});
