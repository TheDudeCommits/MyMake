import { NextResponse } from "next/server";

import {
  applyCodexBridgeWorkspace,
  getDashboardSnapshot,
  getWorkspaceSnapshot,
} from "@/lib/server/project-service";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  { params }: { params: { projectId: string } },
) {
  try {
    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      throw new Error("Codex did not return a workspace zip to apply.");
    }

    const prompt = String(formData.get("prompt") || "").trim();
    if (!prompt) {
      throw new Error("A prompt is required to apply Codex changes.");
    }

    const summary = String(formData.get("summary") || "").trim() || "Codex updated the project.";
    const threadId = String(formData.get("threadId") || "").trim() || null;
    const selectionRaw = String(formData.get("selection") || "").trim();
    const changedFilesRaw = String(formData.get("changedFiles") || "").trim();
    const selection = selectionRaw ? JSON.parse(selectionRaw) : null;
    const changedFiles = changedFilesRaw ? JSON.parse(changedFilesRaw) : [];

    const result = await applyCodexBridgeWorkspace({
      projectId: params.projectId,
      zipBuffer: Buffer.from(await file.arrayBuffer()),
      prompt,
      selection,
      summary,
      threadId,
      changedFiles: Array.isArray(changedFiles) ? changedFiles : [],
    });
    const snapshot = await getDashboardSnapshot(params.projectId);

    return NextResponse.json({
      ...snapshot,
      currentProject: result.workspace,
      ai: {
        summary: result.summary,
        warnings: result.warnings,
        changedFiles: result.changedFiles,
      },
    });
  } catch (error) {
    let details: string[] = [];
    let rawProviderOutput: string | null = null;

    try {
      const workspace = await getWorkspaceSnapshot(params.projectId);
      if (workspace.lastValidationResult?.status !== "passed") {
        details = workspace.lastValidationResult?.details || [];
        rawProviderOutput = workspace.lastValidationResult?.rawProviderOutput || null;
      }
    } catch {
      // Keep the error response lightweight if workspace inspection also fails.
    }

    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Codex bridge changes could not be applied.",
        details,
        rawProviderOutput,
      },
      { status: 400 },
    );
  }
}
