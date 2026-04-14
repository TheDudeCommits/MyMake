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
  { params }: { params: { projectId: string } },
) {
  try {
    const body = bodySchema.parse(await request.json());
    const target = await resolveProjectSelection({
      projectId: params.projectId,
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
