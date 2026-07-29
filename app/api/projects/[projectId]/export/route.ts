import { constants as fsConstants } from "node:fs";
import fsp from "node:fs/promises";
import { Readable } from "node:stream";

import { NextResponse } from "next/server";

import { createProjectExport } from "@/lib/server/project-service";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: { projectId: string } },
) {
  let archiveHandle: Awaited<ReturnType<typeof fsp.open>> | null = null;
  try {
    const archivePath = await createProjectExport(params.projectId);
    archiveHandle = await fsp.open(
      archivePath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    const stats = await archiveHandle.stat();
    if (!stats.isFile()) {
      throw new Error("Could not open the project export.");
    }
    const nodeStream = archiveHandle.createReadStream({ autoClose: true });
    archiveHandle = null;
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
    await archiveHandle?.close().catch(() => undefined);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not export the project." },
      { status: 400 },
    );
  }
}
