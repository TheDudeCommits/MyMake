import { NextResponse } from "next/server";

import { deleteProject, getDashboardSnapshot } from "@/lib/server/project-service";

export const runtime = "nodejs";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;
  try {
    await deleteProject(projectId);
    return NextResponse.json(await getDashboardSnapshot());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not remove the project." },
      { status: 400 },
    );
  }
}
