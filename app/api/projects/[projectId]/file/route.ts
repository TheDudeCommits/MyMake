import { NextResponse } from "next/server";
import { z } from "zod";

import {
  getDashboardSnapshot,
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
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;
  try {
    const url = new URL(request.url);
    const filePath = url.searchParams.get("path");
    if (!filePath) {
      return NextResponse.json({ error: "Missing file path." }, { status: 400 });
    }

    return NextResponse.json(await readProjectFile(projectId, filePath));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not read the file." },
      { status: 400 },
    );
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> },
 ) {
  const { projectId } = await params;
  try {
    const body = updateSchema.parse(await request.json());
    const workspace = await saveProjectFile(projectId, body.path, body.content);
    const snapshot = await getDashboardSnapshot(projectId);
    return NextResponse.json({
      ...snapshot,
      currentProject: workspace,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not save the file." },
      { status: 400 },
    );
  }
}
