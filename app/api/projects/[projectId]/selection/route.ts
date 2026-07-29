import { NextResponse } from "next/server";
import { z } from "zod";

import { resolveProjectSelection } from "@/lib/server/project-service";

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
  selection: selectionSchema,
  currentFilePath: z.string().nullable().optional(),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;
  try {
    const body = bodySchema.parse(await request.json());
    const target = await resolveProjectSelection({
      projectId,
      selection: body.selection,
      currentFilePath: body.currentFilePath,
    });

    return NextResponse.json({ target });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Could not resolve the selected element.",
      },
      { status: 400 },
    );
  }
}
