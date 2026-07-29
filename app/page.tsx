import { WorkspaceApp } from "@/components/workspace-app";
import { getDashboardSnapshot } from "@/lib/server/project-service";

export const dynamic = "force-dynamic";

export default async function Home({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const resolvedSearchParams = searchParams ? await searchParams : undefined;
  const projectIdParam = resolvedSearchParams?.projectId;
  const projectId = Array.isArray(projectIdParam) ? projectIdParam[0] : projectIdParam;
  const snapshot = await getDashboardSnapshot(projectId);

  return <WorkspaceApp initialSnapshot={snapshot} />;
}
