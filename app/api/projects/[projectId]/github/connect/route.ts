import { NextResponse } from "next/server";
import { z } from "zod";

import {
  connectProjectToGitHubRepo,
  createRepoForProject,
  getDashboardSnapshot,
} from "@/lib/server/project-service";

export const runtime = "nodejs";

const bodySchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("existing"),
    owner: z.string().min(1),
    repo: z.string().min(1),
  }),
  z.object({
    mode: z.literal("create"),
    name: z.string().min(1),
    isPrivate: z.boolean().default(true),
  }),
]);

export async function POST(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;
  try {
    const body = bodySchema.parse(await request.json());
    if (body.mode === "existing") {
      await connectProjectToGitHubRepo({
        projectId,
        owner: body.owner,
        repo: body.repo,
      });
    } else {
      await createRepoForProject({
        projectId,
        name: body.name,
        isPrivate: body.isPrivate,
      });
    }

    return NextResponse.json(await getDashboardSnapshot(projectId));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not connect this project to GitHub." },
      { status: 400 },
    );
  }
}
