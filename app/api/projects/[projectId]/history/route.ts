import { NextResponse } from "next/server";
import { z } from "zod";

import { listProjects, redoProject, undoProject } from "@/lib/server/project-service";

export const runtime = "nodejs";

const bodySchema = z.object({
  action: z.enum(["undo", "redo"]),
});

export async function POST(
  request: Request,
  { params }: { params: { projectId: string } },
) {
  try {
    const body = bodySchema.parse(await request.json());
    const workspace =
      body.action === "undo"
        ? await undoProject(params.projectId)
        : await redoProject(params.projectId);

    return NextResponse.json({
      projects: await listProjects(),
      currentProjectId: params.projectId,
      currentProject: workspace,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not update history." },
      { status: 400 },
    );
  }
}
