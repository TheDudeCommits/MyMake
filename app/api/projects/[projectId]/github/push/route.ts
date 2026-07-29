import { NextResponse } from "next/server";

import { getDashboardSnapshot, pushProjectToGitHub } from "@/lib/server/project-service";

export const runtime = "nodejs";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;
  try {
    const result = await pushProjectToGitHub(projectId);
    const snapshot = await getDashboardSnapshot(projectId);
    return NextResponse.json({
      ...snapshot,
      feedback: result.summary,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not push this project to GitHub." },
      { status: 400 },
    );
  }
}
