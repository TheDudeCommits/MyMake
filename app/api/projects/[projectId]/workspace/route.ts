import { NextResponse } from "next/server";

import { DEFAULT_AI_MODEL_KEY, listAiModels } from "@/lib/server/ai";
import { getWorkspaceSnapshot, listProjects } from "@/lib/server/project-service";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  { params }: { params: { projectId: string } },
) {
  try {
    const url = new URL(request.url);
    const filePath = url.searchParams.get("filePath");
    const workspace = await getWorkspaceSnapshot(params.projectId, {
      currentFilePath: filePath,
      ensurePreview: false,
    });
    return NextResponse.json({
      projects: await listProjects(),
      currentProjectId: params.projectId,
      currentProject: workspace,
      aiModels: listAiModels(),
      defaultAiModelKey: DEFAULT_AI_MODEL_KEY,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not load the project." },
      { status: 404 },
    );
  }
}
