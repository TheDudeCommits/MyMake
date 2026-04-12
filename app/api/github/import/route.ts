import { NextResponse } from "next/server";
import { z } from "zod";

import {
  createProjectFromGitHubRepo,
  getDashboardSnapshot,
} from "@/lib/server/project-service";

export const runtime = "nodejs";

const bodySchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
});

export async function POST(request: Request) {
  try {
    const body = bodySchema.parse(await request.json());
    const workspace = await createProjectFromGitHubRepo(body);
    const snapshot = await getDashboardSnapshot(workspace.project.id);

    return NextResponse.json({
      ...snapshot,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not import the GitHub repo." },
      { status: 400 },
    );
  }
}
