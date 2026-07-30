import { notFound } from "next/navigation";

import { getWorkspaceSnapshot } from "@/lib/server/project-service";

export const dynamic = "force-dynamic";

export default async function PublishedProjectPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  try {
    const workspace = await getWorkspaceSnapshot(projectId, {
      ensurePreview: false,
      allowPublic: true,
    });

    return (
      <main className="h-screen w-screen overflow-hidden bg-[#111216]">
        <iframe
          title={`${workspace.project.name} published preview`}
          src={`/public-preview/${projectId}/`}
          className="h-full w-full border-0 bg-[#111216]"
        />
      </main>
    );
  } catch {
    notFound();
  }
}
