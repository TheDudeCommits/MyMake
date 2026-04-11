import { NextResponse } from "next/server";
import { z } from "zod";

import { DEFAULT_AI_MODEL_KEY, listAiModels } from "@/lib/server/ai";
import { applyAiEdit, listProjects } from "@/lib/server/project-service";

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
  aiModelKey: z.enum(["openai-chatgpt-5-2", "anthropic-sonnet-4-6"]).nullable().optional(),
  currentFilePath: z.string().nullable().optional(),
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

    return NextResponse.json({
      projects: await listProjects(),
      currentProjectId: params.projectId,
      currentProject: result.workspace,
      aiModels: listAiModels(),
      defaultAiModelKey: DEFAULT_AI_MODEL_KEY,
      ai: {
        summary: result.summary,
        warnings: result.warnings,
        changedFiles: result.changedFiles,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "The AI edit request failed." },
      { status: 400 },
    );
  }
}
