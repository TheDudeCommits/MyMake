import { NextResponse } from "next/server";
import { z } from "zod";

import { applyAiEdit, getDashboardSnapshot, getWorkspaceSnapshot } from "@/lib/server/project-service";

export const runtime = "nodejs";

const selectionSchema = z
  .object({
    route: z.string(),
    url: z.string(),
    domPath: z.string(),
    selector: z.string().nullable(),
    scopeSelector: z.string().nullable(),
    scopedSelector: z.string().nullable(),
    nearestFramerName: z.string().nullable(),
    framerPath: z.array(z.string()),
    tagName: z.string(),
    textContent: z.string(),
    attributes: z.record(z.string(), z.string()),
    classes: z.array(z.string()),
    outerHtml: z.string(),
    role: z.string().nullable(),
    href: z.string().nullable(),
    src: z.string().nullable(),
    editableProperties: z.array(z.string()).default([]),
    fingerprint: z.string().optional(),
    instanceScope: z.string().nullable().optional(),
    instanceIndex: z.number().nullable().optional(),
    allInstanceSelector: z.string().nullable().optional(),
    repeatKey: z.string().nullable().optional(),
    targetScope: z.enum(["instance", "all-matching"]).nullable().optional(),
    contextTexts: z.array(z.string()).optional(),
    visualType: z.string().nullable().optional(),
    reactComponentStack: z.array(z.string()).optional(),
    reactSourceHints: z.array(z.string()).optional(),
    sourceAnchor: z
      .object({
        filePath: z.string().nullable(),
        line: z.number().nullable(),
        column: z.number().nullable(),
        componentName: z.string().nullable(),
        ownerStack: z.array(z.string()).default([]),
      })
      .nullable()
      .optional(),
    styleSnapshot: z
      .object({
        textColor: z.string().nullable(),
        lineColor: z.string().nullable(),
        fillColor: z.string().nullable(),
        backgroundColor: z.string().nullable(),
        borderRadius: z.string().nullable(),
        opacity: z.string().nullable(),
        fontSize: z.string().nullable(),
        fontWeight: z.string().nullable(),
        display: z.string().nullable(),
        visibility: z.string().nullable(),
        width: z.number().nullable(),
        height: z.number().nullable(),
        gap: z.string().nullable(),
        rowGap: z.string().nullable(),
        columnGap: z.string().nullable(),
        padding: z.string().nullable(),
        margin: z.string().nullable(),
        imageSrc: z.string().nullable(),
      })
      .nullable()
      .optional(),
    proofHandles: z
      .array(
        z.object({
          key: z.string(),
          label: z.string(),
          value: z.string().nullable(),
          confidence: z.number(),
        }),
      )
      .optional(),
    boundingBox: z.object({
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
    }),
  })
  .nullable();

const bodySchema = z.object({
  projectId: z.string(),
  revisionId: z.string(),
  prompt: z.string().min(1),
  selection: selectionSchema,
  attachmentIds: z.array(z.string()).default([]),
  editMode: z.enum(["precise", "scoped", "creative"]).nullable().optional(),
  aiModelKey: z
    .enum(["openai-chatgpt-5-2", "openai-codex", "anthropic-sonnet-4-6"])
    .nullable()
    .optional(),
  currentFilePath: z.string().nullable().optional(),
  inspectorAction: z
    .object({
      kind: z.enum([
        "replace-text",
        "set-line-color",
        "set-fill-color",
        "set-background-color",
        "set-spacing",
        "set-radius",
        "set-size",
        "set-visibility",
        "swap-image",
      ]),
      value: z.string().nullable().optional(),
      axis: z.enum(["all", "x", "y"]).nullable().optional(),
    })
    .nullable()
    .optional(),
});

export async function POST(
  request: Request,
  { params }: { params: { projectId: string } },
) {
  try {
    const body = bodySchema.parse(await request.json());
    const result = await applyAiEdit({
      ...body,
      projectId: params.projectId,
    });
    const snapshot = await getDashboardSnapshot(params.projectId);

    return NextResponse.json({
      ...snapshot,
      currentProject: result.workspace,
      ai: {
        summary: result.summary,
        warnings: result.warnings,
        changedFiles: result.changedFiles,
      },
    });
  } catch (error) {
    let details: string[] = [];
    let rawProviderOutput: string | null = null;

    try {
      const workspace = await getWorkspaceSnapshot(params.projectId);
      if (workspace.lastValidationResult?.status !== "passed") {
        details = workspace.lastValidationResult?.details || [];
        rawProviderOutput = workspace.lastValidationResult?.rawProviderOutput || null;
      }
    } catch {
      // Keep the error response lightweight if workspace inspection also fails.
    }

    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "The AI edit request failed.",
        details,
        rawProviderOutput,
      },
      { status: 400 },
    );
  }
}
