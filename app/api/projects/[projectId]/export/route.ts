import fs from "node:fs";
import fsp from "node:fs/promises";
import { Readable } from "node:stream";

import { NextResponse } from "next/server";

import { createProjectExport } from "@/lib/server/project-service";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: { projectId: string } },
) {
  try {
    const archivePath = await createProjectExport(params.projectId);
    const stats = await fsp.stat(archivePath);
    const nodeStream = fs.createReadStream(archivePath);
    nodeStream.on("close", () => {
      void fsp.rm(archivePath, { force: true }).catch(() => undefined);
    });

    return new NextResponse(Readable.toWeb(nodeStream) as ReadableStream, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${params.projectId}.zip"`,
        "Content-Length": String(stats.size),
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not export the project." },
      { status: 400 },
    );
  }
}
