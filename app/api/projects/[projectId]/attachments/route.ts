import { NextResponse } from "next/server";

import { AttachmentManager } from "@/lib/server/attachment-manager";
import { saveAttachments } from "@/lib/server/project-service";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  { params }: { params: { projectId: string } },
) {
  try {
    const formData = await request.formData();
    const files = formData
      .getAll("files")
      .filter((item): item is File => item instanceof File);

    if (!files.length) {
      return NextResponse.json({ error: "No attachments were provided." }, { status: 400 });
    }

    const validation = new AttachmentManager().validate(files);
    if (!validation.valid) {
      return NextResponse.json({ error: validation.errors.join(" ") }, { status: 400 });
    }

    const attachments = await saveAttachments(
      params.projectId,
      await Promise.all(
        files.map(async (file) => ({
          filename: file.name,
          mimeType: file.type || "application/octet-stream",
          data: Buffer.from(await file.arrayBuffer()),
        })),
      ),
    );

    return NextResponse.json({ attachments });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not save attachments." },
      { status: 400 },
    );
  }
}
