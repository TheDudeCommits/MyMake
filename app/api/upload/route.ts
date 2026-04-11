import { NextResponse } from "next/server";

import { DEFAULT_AI_MODEL_KEY, listAiModels } from "@/lib/server/ai";
import { createProjectFromUpload, listProjects } from "@/lib/server/project-service";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Please upload a zip file." }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const workspace = await createProjectFromUpload(file.name, buffer);
    return NextResponse.json({
      projects: await listProjects(),
      currentProjectId: workspace.project.id,
      currentProject: workspace,
      aiModels: listAiModels(),
      defaultAiModelKey: DEFAULT_AI_MODEL_KEY,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Upload failed." },
      { status: 400 },
    );
  }
}
