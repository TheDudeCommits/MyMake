import { NextResponse } from "next/server";

import { listAvailableGitHubRepos } from "@/lib/server/project-service";

export const runtime = "nodejs";

export async function GET() {
  try {
    const repos = await listAvailableGitHubRepos();
    return NextResponse.json({ repos });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not load GitHub repos." },
      { status: 400 },
    );
  }
}
