import { NextResponse } from "next/server";
import { z } from "zod";

import { DEFAULT_AI_MODEL_KEY, listAiModels } from "@/lib/server/ai";
import {
  listProjects,
  redoProject,
  restoreProjectRevision,
  undoProject,
} from "@/lib/server/project-service";

export const runtime = "nodejs";

const bodySchema = z.union([
  z.object({
    action: z.enum(["undo", "redo"]),
  }),
  z.object({
    revisionId: z.string().min(1),
  }),
]);

export async function POST(
  request: Request,
  { params }: { params: { projectId: string } },
) {
  try {
    const body = bodySchema.parse(await request.json());
    const workspace =
      "action" in body
        ? body.action === "undo"
          ? await undoProject(params.projectId)
          : await redoProject(params.projectId)
        : await restoreProjectRevision(params.projectId, body.revisionId);

    return NextResponse.json({
      projects: await listProjects(),
      currentProjectId: params.projectId,
      currentProject: workspace,
      aiModels: listAiModels(),
      defaultAiModelKey: DEFAULT_AI_MODEL_KEY,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not update history." },
      { status: 400 },
    );
  }
}
