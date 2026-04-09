import fs from "node:fs/promises";

import { NextResponse } from "next/server";

import { createProjectExport } from "@/lib/server/project-service";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: { projectId: string } },
) {
  try {
    const archivePath = await createProjectExport(params.projectId);
    const fileBuffer = await fs.readFile(archivePath);

    return new NextResponse(fileBuffer, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${params.projectId}.zip"`,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not export the project." },
      { status: 400 },
    );
  }
}
