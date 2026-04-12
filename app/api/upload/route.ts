import { NextResponse } from "next/server";

import { createProjectFromUpload, getDashboardSnapshot } from "@/lib/server/project-service";

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
    const snapshot = await getDashboardSnapshot(workspace.project.id);
    return NextResponse.json({
      ...snapshot,
      currentProject: workspace,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Upload failed." },
      { status: 400 },
    );
  }
}
