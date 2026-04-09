import { NextResponse } from "next/server";
import { z } from "zod";

import {
  listProjects,
  readProjectFile,
  saveProjectFile,
} from "@/lib/server/project-service";

export const runtime = "nodejs";

const updateSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
});

export async function GET(
  request: Request,
  { params }: { params: { projectId: string } },
) {
  try {
    const url = new URL(request.url);
    const filePath = url.searchParams.get("path");
    if (!filePath) {
      return NextResponse.json({ error: "Missing file path." }, { status: 400 });
    }

    return NextResponse.json(await readProjectFile(params.projectId, filePath));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not read the file." },
      { status: 400 },
    );
  }
}

export async function PUT(
  request: Request,
  { params }: { params: { projectId: string } },
) {
  try {
    const body = updateSchema.parse(await request.json());
    const workspace = await saveProjectFile(params.projectId, body.path, body.content);
    return NextResponse.json({
      projects: await listProjects(),
      currentProjectId: params.projectId,
      currentProject: workspace,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not save the file." },
      { status: 400 },
    );
  }
}
