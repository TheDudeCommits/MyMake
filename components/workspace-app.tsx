"use client";

import MonacoEditor from "@monaco-editor/react";
import {
  ChevronRight,
  Code2,
  Download,
  Eye,
  FileCode2,
  FolderKanban,
  ImagePlus,
  Laptop,
  Loader2,
  LogOut,
  MonitorSmartphone,
  MousePointerSquareDashed,
  RefreshCcw,
  Save,
  SendHorizonal,
  Smartphone,
  Sparkles,
  Tablet,
  Undo2,
  Upload,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type {
  AttachmentRecord,
  DashboardSnapshot,
  DevicePreset,
  FileNode,
  ProjectWorkspace,
  SelectionPayload,
} from "@/lib/types";

const DEVICE_PRESETS: Record<DevicePreset, { label: string; width: string; icon: typeof Laptop }> = {
  desktop: { label: "Desktop", width: "100%", icon: Laptop },
  tablet: { label: "Tablet", width: "820px", icon: Tablet },
  mobile: { label: "Mobile", width: "390px", icon: Smartphone },
};

type SnapshotResponse = DashboardSnapshot & {
  ai?: {
    summary: string;
    warnings: string[];
    changedFiles: Array<{ path: string; reason?: string }>;
  };
};

function clsx(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

function languageForPath(filePath: string | null): string {
  if (!filePath) {
    return "typescript";
  }

  if (filePath.endsWith(".css") || filePath.endsWith(".scss")) {
    return "css";
  }

  if (filePath.endsWith(".json")) {
    return "json";
  }

  if (filePath.endsWith(".md") || filePath.endsWith(".mdx")) {
    return "markdown";
  }

  if (filePath.endsWith(".html")) {
    return "html";
  }

  if (filePath.endsWith(".js") || filePath.endsWith(".jsx")) {
    return "javascript";
  }

  return "typescript";
}

function formatTimestamp(value: string): string {
  return `${value.replace("T", " ").slice(0, 16)} UTC`;
}

function flattenFileNodes(nodes: FileNode[]): FileNode[] {
  return nodes.flatMap((node) =>
    node.type === "directory" ? [node, ...flattenFileNodes(node.children || [])] : [node],
  );
}

function StatusPill({ status }: { status: ProjectWorkspace["project"]["status"] }) {
  const styles =
    status === "ready"
      ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-200"
      : status === "installing"
        ? "border-amber-300/30 bg-amber-300/10 text-amber-100"
        : "border-rose-400/30 bg-rose-400/10 text-rose-100";

  return (
    <span
      className={clsx(
        "rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.22em]",
        styles,
      )}
    >
      {status}
    </span>
  );
}

function FileTree({
  nodes,
  activePath,
  onSelect,
}: {
  nodes: FileNode[];
  activePath: string | null;
  onSelect: (path: string) => void;
}) {
  return (
    <div className="space-y-1">
      {nodes.map((node) => (
        <FileTreeNode key={node.path} node={node} activePath={activePath} onSelect={onSelect} />
      ))}
    </div>
  );
}

function FileTreeNode({
  node,
  activePath,
  onSelect,
}: {
  node: FileNode;
  activePath: string | null;
  onSelect: (path: string) => void;
}) {
  const [open, setOpen] = useState(true);

  if (node.type === "directory") {
    return (
      <div>
        <button
          className="flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-left text-sm text-slate-300 transition hover:bg-white/5"
          type="button"
          onClick={() => setOpen((value) => !value)}
        >
          {open ? <ChevronDownSmall /> : <ChevronRightSmall />}
          <FolderKanban className="h-4 w-4 text-slate-400" />
          <span>{node.name}</span>
        </button>
        {open ? (
          <div className="ml-4 border-l border-white/5 pl-2">
            {(node.children || []).map((child) => (
              <FileTreeNode
                key={child.path}
                node={child}
                activePath={activePath}
                onSelect={onSelect}
              />
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <button
      className={clsx(
        "flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-left text-sm transition",
        activePath === node.path
          ? "bg-[linear-gradient(135deg,rgba(124,92,255,0.22),rgba(49,200,255,0.18))] text-white"
          : "text-slate-300 hover:bg-white/5",
      )}
      type="button"
      onClick={() => onSelect(node.path)}
    >
      <FileCode2 className="h-4 w-4 text-slate-400" />
      <span className="truncate">{node.name}</span>
      {!node.editable ? (
        <span className="ml-auto rounded-full border border-white/10 px-2 py-0.5 text-[10px] uppercase tracking-[0.2em] text-slate-500">
          view
        </span>
      ) : null}
    </button>
  );
}

function ChevronDownSmall() {
  return <ChevronRight className="h-4 w-4 rotate-90 text-slate-500" />;
}

function ChevronRightSmall() {
  return <ChevronRight className="h-4 w-4 text-slate-500" />;
}

export function WorkspaceApp({ initialSnapshot }: { initialSnapshot: DashboardSnapshot }) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [devicePreset, setDevicePreset] = useState<DevicePreset>("desktop");
  const [isPicking, setIsPicking] = useState(true);
  const [isCodePanelOpen, setIsCodePanelOpen] = useState(true);
  const [selectedElement, setSelectedElement] = useState<SelectionPayload | null>(null);
  const [currentRoute, setCurrentRoute] = useState("/");
  const [prompt, setPrompt] = useState("");
  const [editorFilePath, setEditorFilePath] = useState<string | null>(
    initialSnapshot.currentProject?.currentFilePath || null,
  );
  const [editorContent, setEditorContent] = useState(
    initialSnapshot.currentProject?.currentFileContent || "",
  );
  const [isUploading, setIsUploading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isRunningAi, setIsRunningAi] = useState(false);
  const [isUploadingAttachments, setIsUploadingAttachments] = useState(false);
  const [selectedAttachmentIds, setSelectedAttachmentIds] = useState<string[]>([]);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const projectUploadInputRef = useRef<HTMLInputElement>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);

  const currentProject = snapshot.currentProject;
  const revisions = currentProject?.revisions || [];
  const attachments = currentProject?.attachments || [];
  const editableFiles = useMemo(
    () =>
      currentProject
        ? flattenFileNodes(currentProject.fileTree).filter(
            (item) => item.type === "file" && item.editable,
          )
        : [],
    [currentProject],
  );

  useEffect(() => {
    setEditorFilePath(currentProject?.currentFilePath || null);
    setEditorContent(currentProject?.currentFileContent || "");
  }, [currentProject?.currentFilePath, currentProject?.currentFileContent]);

  useEffect(() => {
    setSelectedAttachmentIds([]);
    setSelectedElement(null);
    setCurrentRoute("/");
  }, [currentProject?.project.id]);

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (!event.data || event.data.channel !== "MYMAKE_PREVIEW_BRIDGE") {
        return;
      }

      if (event.data.type === "MYMAKE_SELECT") {
        setSelectedElement(event.data.payload as SelectionPayload);
        setCurrentRoute(event.data.payload?.route || "/");
        return;
      }

      if (event.data.type === "MYMAKE_ROUTE" || event.data.type === "MYMAKE_READY") {
        setCurrentRoute(event.data.payload?.route || "/");
      }
    }

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  useEffect(() => {
    const frameWindow = iframeRef.current?.contentWindow;
    if (!frameWindow || !currentProject) {
      return;
    }

    frameWindow.postMessage(
      {
        channel: "MYMAKE_PREVIEW_BRIDGE",
        type: "MYMAKE_SET_PICKING",
        payload: { enabled: isPicking },
      },
      "*",
    );
  }, [currentProject, isPicking]);

  async function readJsonResponse<T>(response: Response): Promise<T> {
    const payload = (await response.json()) as T & { error?: string };
    if (!response.ok) {
      throw new Error((payload as { error?: string }).error || "Request failed.");
    }

    return payload;
  }

  function applySnapshot(nextSnapshot: SnapshotResponse) {
    setSnapshot(nextSnapshot);
    setError(null);
    if (nextSnapshot.ai?.summary) {
      setFeedback(nextSnapshot.ai.summary);
    }
  }

  async function refreshProject(projectId: string, filePath?: string | null) {
    const url = new URL(`/api/projects/${projectId}/workspace`, window.location.origin);
    if (filePath) {
      url.searchParams.set("filePath", filePath);
    }

    const response = await fetch(url.toString(), { cache: "no-store" });
    const data = await readJsonResponse<SnapshotResponse>(response);
    applySnapshot(data);
  }

  async function handleProjectUpload(file: File) {
    setIsUploading(true);
    setError(null);
    setFeedback("Importing project, installing dependencies, and starting the preview...");

    try {
      const formData = new FormData();
      formData.set("file", file);
      const response = await fetch("/api/upload", {
        method: "POST",
        body: formData,
      });
      const data = await readJsonResponse<SnapshotResponse>(response);
      applySnapshot(data);
      setFeedback(`Imported ${file.name} and booted its live preview.`);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Upload failed.");
    } finally {
      setIsUploading(false);
    }
  }

  async function handleProjectChange(projectId: string) {
    setFeedback("Loading project workspace...");
    try {
      await refreshProject(projectId);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Could not open project.");
    }
  }

  async function handleFileSelect(filePath: string) {
    if (!currentProject) {
      return;
    }

    try {
      const response = await fetch(
        `/api/projects/${currentProject.project.id}/file?path=${encodeURIComponent(filePath)}`,
        { cache: "no-store" },
      );
      const payload = await readJsonResponse<{ path: string; content: string }>(response);
      setEditorFilePath(payload.path);
      setEditorContent(payload.content);
      setFeedback(`Opened ${payload.path}`);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Could not open the file.");
    }
  }

  async function handleSave() {
    if (!currentProject || !editorFilePath) {
      return;
    }

    setIsSaving(true);
    setError(null);

    try {
      const response = await fetch(`/api/projects/${currentProject.project.id}/file`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          path: editorFilePath,
          content: editorContent,
        }),
      });
      const data = await readJsonResponse<SnapshotResponse>(response);
      applySnapshot(data);
      setFeedback(`Saved ${editorFilePath}`);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Could not save the file.");
    } finally {
      setIsSaving(false);
    }
  }

  async function handleAttachmentUpload(files: FileList | null) {
    if (!currentProject || !files?.length) {
      return;
    }

    setIsUploadingAttachments(true);
    try {
      const formData = new FormData();
      Array.from(files).forEach((file) => formData.append("files", file));

      const response = await fetch(`/api/projects/${currentProject.project.id}/attachments`, {
        method: "POST",
        body: formData,
      });
      const payload = await readJsonResponse<{ attachments: AttachmentRecord[] }>(response);

      setSnapshot((previous) => {
        if (!previous.currentProject) {
          return previous;
        }

        return {
          ...previous,
          currentProject: {
            ...previous.currentProject,
            attachments: [...payload.attachments, ...previous.currentProject.attachments],
          },
        };
      });
      setSelectedAttachmentIds((previous) =>
        Array.from(new Set([...previous, ...payload.attachments.map((item) => item.id)])),
      );
      setFeedback(`Attached ${payload.attachments.length} reference file(s).`);
    } catch (caughtError) {
      setError(
        caughtError instanceof Error ? caughtError.message : "Could not upload attachments.",
      );
    } finally {
      setIsUploadingAttachments(false);
    }
  }

  async function handleAiEdit() {
    if (!currentProject?.project.currentRevisionId || !prompt.trim()) {
      return;
    }

    setIsRunningAi(true);
    setError(null);
    setFeedback("Claude is updating the selected UI and refreshing the preview...");

    try {
      const response = await fetch(`/api/projects/${currentProject.project.id}/ai-edit`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          projectId: currentProject.project.id,
          revisionId: currentProject.project.currentRevisionId,
          prompt,
          selection: selectedElement,
          attachmentIds: selectedAttachmentIds,
          currentFilePath: editorFilePath,
        }),
      });
      const data = await readJsonResponse<SnapshotResponse>(response);
      applySnapshot(data);
      setPrompt("");
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "AI edit failed.");
    } finally {
      setIsRunningAi(false);
    }
  }

  async function handleHistory(action: "undo" | "redo") {
    if (!currentProject) {
      return;
    }

    try {
      const response = await fetch(`/api/projects/${currentProject.project.id}/history`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action }),
      });
      const data = await readJsonResponse<SnapshotResponse>(response);
      applySnapshot(data);
      setFeedback(action === "undo" ? "Moved one revision back." : "Moved one revision forward.");
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "History update failed.");
    }
  }

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/auth";
  }

  function toggleAttachmentSelection(attachmentId: string) {
    setSelectedAttachmentIds((previous) =>
      previous.includes(attachmentId)
        ? previous.filter((value) => value !== attachmentId)
        : [...previous, attachmentId],
    );
  }

  const previewWidth = DEVICE_PRESETS[devicePreset].width;

  return (
    <main className="min-h-screen px-4 py-4 text-white md:px-5">
      <div className="grid min-h-[calc(100vh-2rem)] overflow-hidden rounded-[30px] border border-white/10 bg-[linear-gradient(180deg,rgba(7,10,18,0.97),rgba(5,7,12,0.99))] shadow-[0_35px_120px_rgba(0,0,0,0.45)] xl:grid-cols-[320px_minmax(0,1fr)_460px]">
        <aside className="border-b border-white/8 bg-white/[0.03] px-5 py-5 xl:border-b-0 xl:border-r">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-[0.3em] text-slate-500">Private Studio</p>
              <h1 className="mt-3 text-3xl font-semibold tracking-[-0.06em]">MyMake</h1>
              <p className="mt-2 text-sm leading-6 text-slate-400">
                Upload a Next.js design zip, inspect the live preview, and rewrite the UI with AI.
              </p>
            </div>
            <button
              className="rounded-2xl border border-white/10 bg-white/[0.04] p-3 text-slate-300 transition hover:bg-white/[0.08]"
              type="button"
              onClick={handleLogout}
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>

          <div className="mt-6 rounded-[24px] border border-dashed border-cyan-300/25 bg-cyan-400/5 p-4">
            <div className="flex items-center gap-3">
              <div className="rounded-2xl bg-cyan-400/10 p-2 text-cyan-200">
                <Upload className="h-5 w-5" />
              </div>
              <div>
                <p className="text-sm font-semibold">Import a zipped design app</p>
                <p className="mt-1 text-xs leading-5 text-slate-400">
                  Supports single Next.js frontend projects with local assets and no external
                  services.
                </p>
              </div>
            </div>
            <button
              className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-[linear-gradient(135deg,rgba(49,200,255,0.95),rgba(124,92,255,0.88))] px-4 py-3 text-sm font-semibold shadow-[0_18px_40px_rgba(63,183,255,0.24)] transition hover:translate-y-[-1px] disabled:cursor-not-allowed disabled:opacity-60"
              type="button"
              disabled={isUploading}
              onClick={() => projectUploadInputRef.current?.click()}
            >
              {isUploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              {isUploading ? "Importing..." : "Upload zip"}
            </button>
            <input
              ref={projectUploadInputRef}
              hidden
              accept=".zip"
              type="file"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) {
                  void handleProjectUpload(file);
                }
                event.target.value = "";
              }}
            />
          </div>

          <section className="mt-8">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-xs uppercase tracking-[0.26em] text-slate-500">Projects</h2>
              <span className="text-xs text-slate-500">{snapshot.projects.length}</span>
            </div>
            <div className="space-y-3">
              {snapshot.projects.length ? (
                snapshot.projects.map((project) => (
                  <button
                    key={project.id}
                    className={clsx(
                      "w-full rounded-[22px] border px-4 py-4 text-left transition",
                      currentProject?.project.id === project.id
                        ? "border-cyan-300/30 bg-[linear-gradient(135deg,rgba(124,92,255,0.18),rgba(49,200,255,0.12))]"
                        : "border-white/8 bg-white/[0.025] hover:bg-white/[0.05]",
                    )}
                    type="button"
                    onClick={() => void handleProjectChange(project.id)}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-white">{project.name}</p>
                        <p className="mt-1 text-xs text-slate-400">{formatTimestamp(project.lastOpenedAt)}</p>
                      </div>
                      <StatusPill status={project.status} />
                    </div>
                  </button>
                ))
              ) : (
                <div className="rounded-[22px] border border-white/8 bg-white/[0.025] p-4 text-sm text-slate-400">
                  Your imported projects will show up here.
                </div>
              )}
            </div>
          </section>

          <section className="mt-8">
            <h2 className="mb-3 text-xs uppercase tracking-[0.26em] text-slate-500">
              Selected Element
            </h2>
            <div className="rounded-[24px] border border-white/8 bg-white/[0.025] p-4">
              {selectedElement ? (
                <div className="space-y-3 text-sm text-slate-200">
                  <div className="flex items-center gap-2 text-cyan-200">
                    <MousePointerSquareDashed className="h-4 w-4" />
                    <span className="font-medium">
                      {selectedElement.tagName} on {selectedElement.route}
                    </span>
                  </div>
                  <p className="rounded-xl bg-black/25 px-3 py-2 text-xs text-slate-300">
                    {selectedElement.domPath}
                  </p>
                  <p className="text-xs leading-6 text-slate-400">
                    {selectedElement.textContent || "No direct text content on this element."}
                  </p>
                </div>
              ) : (
                <p className="text-sm leading-6 text-slate-400">
                  Pick an element inside the preview to send precise context to Claude.
                </p>
              )}
            </div>
          </section>

          <section className="mt-8">
            <h2 className="mb-3 text-xs uppercase tracking-[0.26em] text-slate-500">
              Revision Activity
            </h2>
            <div className="space-y-2">
              {revisions.slice(0, 8).map((revision) => (
                <div
                  key={revision.id}
                  className="rounded-[20px] border border-white/8 bg-white/[0.025] px-4 py-3"
                >
                  <div className="flex items-center justify-between gap-3">
                    <p className="truncate text-sm font-medium text-white">{revision.label}</p>
                    <span className="rounded-full border border-white/8 px-2 py-1 text-[10px] uppercase tracking-[0.18em] text-slate-400">
                      {revision.source}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-slate-500">{formatTimestamp(revision.createdAt)}</p>
                </div>
              ))}
            </div>
          </section>
        </aside>

        <section className="relative flex min-h-[620px] flex-col">
          <header className="flex flex-wrap items-center justify-between gap-4 border-b border-white/8 px-5 py-4">
            <div>
              <p className="text-xs uppercase tracking-[0.26em] text-slate-500">Live Preview</p>
              <div className="mt-2 flex items-center gap-3">
                <h2 className="text-xl font-semibold tracking-[-0.05em]">
                  {currentProject?.project.name || "No project open"}
                </h2>
                {currentProject ? <StatusPill status={currentProject.project.status} /> : null}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {(Object.entries(DEVICE_PRESETS) as Array<[DevicePreset, (typeof DEVICE_PRESETS)[DevicePreset]]>).map(
                ([key, preset]) => {
                  const Icon = preset.icon;
                  return (
                    <button
                      key={key}
                      className={clsx(
                        "inline-flex items-center gap-2 rounded-2xl border px-4 py-2 text-sm transition",
                        devicePreset === key
                          ? "border-cyan-300/30 bg-cyan-300/10 text-cyan-100"
                          : "border-white/8 bg-white/[0.03] text-slate-300 hover:bg-white/[0.06]",
                      )}
                      type="button"
                      onClick={() => setDevicePreset(key)}
                    >
                      <Icon className="h-4 w-4" />
                      {preset.label}
                    </button>
                  );
                },
              )}

              <button
                className={clsx(
                  "inline-flex items-center gap-2 rounded-2xl border px-4 py-2 text-sm transition",
                  isPicking
                    ? "border-cyan-300/30 bg-cyan-300/10 text-cyan-100"
                    : "border-white/8 bg-white/[0.03] text-slate-300 hover:bg-white/[0.06]",
                )}
                type="button"
                onClick={() => setIsPicking((value) => !value)}
              >
                <MousePointerSquareDashed className="h-4 w-4" />
                Pick
              </button>

              <button
                className="inline-flex items-center gap-2 rounded-2xl border border-white/8 bg-white/[0.03] px-4 py-2 text-sm text-slate-300 transition hover:bg-white/[0.06]"
                type="button"
                onClick={() => setIsCodePanelOpen((value) => !value)}
              >
                <Code2 className="h-4 w-4" />
                {isCodePanelOpen ? "Hide Code" : "Show Code"}
              </button>

              <button
                className="inline-flex items-center gap-2 rounded-2xl border border-white/8 bg-white/[0.03] px-4 py-2 text-sm text-slate-300 transition hover:bg-white/[0.06]"
                type="button"
                onClick={() => currentProject && void handleHistory("undo")}
              >
                <Undo2 className="h-4 w-4" />
                Undo
              </button>

              <button
                className="inline-flex items-center gap-2 rounded-2xl border border-white/8 bg-white/[0.03] px-4 py-2 text-sm text-slate-300 transition hover:bg-white/[0.06]"
                type="button"
                onClick={() => currentProject && void handleHistory("redo")}
              >
                <RefreshCcw className="h-4 w-4" />
                Redo
              </button>

              <button
                className="inline-flex items-center gap-2 rounded-2xl bg-white text-sm font-semibold text-slate-900 px-4 py-2 transition hover:bg-slate-200"
                type="button"
                onClick={() =>
                  currentProject &&
                  window.open(`/api/projects/${currentProject.project.id}/export`, "_blank", "noopener,noreferrer")
                }
              >
                <Download className="h-4 w-4" />
                Export
              </button>
            </div>
          </header>

          <div className="relative flex-1 overflow-hidden px-5 pb-5 pt-5">
            <div className="absolute inset-x-0 top-0 h-24 bg-[radial-gradient(circle_at_top,rgba(49,200,255,0.12),transparent_62%)]" />
            <div className="relative flex h-full min-h-[420px] flex-col overflow-hidden rounded-[28px] border border-white/8 bg-[linear-gradient(180deg,rgba(255,255,255,0.03),rgba(255,255,255,0.015))]">
              <div className="flex items-center justify-between border-b border-white/8 px-4 py-3 text-xs uppercase tracking-[0.24em] text-slate-500">
                <span className="flex items-center gap-2">
                  <Eye className="h-4 w-4" />
                  Route {currentRoute}
                </span>
                <span className="rounded-full border border-white/8 px-3 py-1 text-[10px] text-slate-400">
                  {DEVICE_PRESETS[devicePreset].label}
                </span>
              </div>

              <div className="flex flex-1 items-center justify-center overflow-auto bg-[radial-gradient(circle_at_top,rgba(124,92,255,0.12),transparent_30%),linear-gradient(180deg,rgba(6,8,14,0.75),rgba(6,8,14,0.96))] p-5">
                {currentProject ? (
                  <div
                    className="max-h-full overflow-hidden rounded-[26px] border border-white/10 bg-[#090d16] shadow-[0_35px_90px_rgba(0,0,0,0.45)] transition-all duration-300"
                    style={{
                      width: previewWidth,
                      maxWidth: "100%",
                    }}
                  >
                    <iframe
                      key={`${currentProject.project.id}-${currentProject.project.currentRevisionId}`}
                      ref={iframeRef}
                      title={`${currentProject.project.name} preview`}
                      src={`${currentProject.preview.url}/`}
                      className="h-[70vh] min-h-[480px] w-full bg-white"
                      onLoad={() => {
                        iframeRef.current?.contentWindow?.postMessage(
                          {
                            channel: "MYMAKE_PREVIEW_BRIDGE",
                            type: "MYMAKE_PING",
                          },
                          "*",
                        );
                      }}
                    />
                  </div>
                ) : (
                  <div className="mx-auto max-w-xl text-center">
                    <div className="mx-auto inline-flex rounded-3xl border border-white/10 bg-white/[0.04] p-5 text-cyan-200">
                      <MonitorSmartphone className="h-8 w-8" />
                    </div>
                    <h3 className="mt-6 text-3xl font-semibold tracking-[-0.05em] text-white">
                      Import your first design project
                    </h3>
                    <p className="mt-4 text-base leading-8 text-slate-400">
                      Upload a Next.js zip from the left rail to start a live preview workspace with
                      direct element picking, AI edits, revision history, and export.
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>

          <footer className="border-t border-white/8 px-5 py-4">
            <div className="rounded-[28px] border border-white/8 bg-white/[0.025] p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="rounded-2xl bg-[linear-gradient(135deg,rgba(124,92,255,0.2),rgba(49,200,255,0.16))] p-3 text-cyan-100">
                    <Sparkles className="h-5 w-5" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-white">AI Edit Bar</p>
                    <p className="text-xs text-slate-400">
                      {selectedElement
                        ? `Targeting ${selectedElement.tagName} on ${selectedElement.route}`
                        : "Claude will use the current route plus your code context."}
                    </p>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    className="inline-flex items-center gap-2 rounded-2xl border border-white/8 bg-white/[0.03] px-3 py-2 text-sm text-slate-300 transition hover:bg-white/[0.06]"
                    type="button"
                    onClick={() => attachmentInputRef.current?.click()}
                  >
                    {isUploadingAttachments ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <ImagePlus className="h-4 w-4" />
                    )}
                    Attach files
                  </button>
                  <button
                    className="inline-flex items-center gap-2 rounded-2xl bg-[linear-gradient(135deg,#32c8ff,#7c5cff)] px-4 py-2 text-sm font-semibold shadow-[0_18px_40px_rgba(50,200,255,0.2)] transition hover:translate-y-[-1px] disabled:cursor-not-allowed disabled:opacity-50"
                    type="button"
                    disabled={isRunningAi || !currentProject?.project.currentRevisionId || !prompt.trim()}
                    onClick={() => void handleAiEdit()}
                  >
                    {isRunningAi ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <SendHorizonal className="h-4 w-4" />
                    )}
                    {isRunningAi ? "Editing..." : "Apply AI edit"}
                  </button>
                </div>
              </div>

              {attachments.length ? (
                <div className="mt-4 flex flex-wrap gap-2">
                  {attachments.map((attachment) => (
                    <button
                      key={attachment.id}
                      className={clsx(
                        "rounded-full border px-3 py-1.5 text-xs transition",
                        selectedAttachmentIds.includes(attachment.id)
                          ? "border-cyan-300/30 bg-cyan-300/10 text-cyan-100"
                          : "border-white/8 bg-white/[0.03] text-slate-300 hover:bg-white/[0.05]",
                      )}
                      type="button"
                      onClick={() => toggleAttachmentSelection(attachment.id)}
                    >
                      {attachment.filename}
                    </button>
                  ))}
                </div>
              ) : null}

              <textarea
                className="mt-4 min-h-[120px] w-full rounded-[24px] border border-white/8 bg-black/25 px-4 py-4 text-sm leading-7 text-white outline-none transition placeholder:text-slate-500 focus:border-cyan-300/40 focus:bg-black/35"
                placeholder='Try: "Make this hero button bigger, shift the palette to dark navy, and tighten the spacing between these cards."'
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
              />

              <input
                ref={attachmentInputRef}
                hidden
                multiple
                type="file"
                onChange={(event) => {
                  void handleAttachmentUpload(event.target.files);
                  event.target.value = "";
                }}
              />

              {feedback ? (
                <div className="mt-4 rounded-2xl border border-emerald-300/20 bg-emerald-300/10 px-4 py-3 text-sm text-emerald-100">
                  {feedback}
                </div>
              ) : null}

              {error ? (
                <div className="mt-4 rounded-2xl border border-rose-400/20 bg-rose-400/10 px-4 py-3 text-sm text-rose-100">
                  {error}
                </div>
              ) : null}
            </div>
          </footer>
        </section>

        <aside
          className={clsx(
            "border-t border-white/8 bg-[linear-gradient(180deg,rgba(10,14,24,0.94),rgba(6,8,14,0.98))] xl:border-l xl:border-t-0",
            isCodePanelOpen ? "block" : "hidden xl:block",
          )}
        >
          <div className="flex h-full flex-col">
            <div className="flex items-center justify-between border-b border-white/8 px-5 py-4">
              <div>
                <p className="text-xs uppercase tracking-[0.26em] text-slate-500">Code Drawer</p>
                <h2 className="mt-2 text-lg font-semibold tracking-[-0.04em]">Manual edits</h2>
              </div>
              <div className="flex items-center gap-2">
                <button
                  className="inline-flex items-center gap-2 rounded-2xl border border-white/8 bg-white/[0.03] px-3 py-2 text-sm text-slate-300 transition hover:bg-white/[0.06]"
                  type="button"
                  disabled={isSaving || !editorFilePath}
                  onClick={() => void handleSave()}
                >
                  {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                  Save
                </button>
                <button
                  className="rounded-2xl border border-white/8 bg-white/[0.03] p-2 text-slate-300 transition hover:bg-white/[0.06] xl:hidden"
                  type="button"
                  onClick={() => setIsCodePanelOpen(false)}
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            </div>

            <div className="grid min-h-0 flex-1 grid-cols-[260px_minmax(0,1fr)]">
              <div className="min-h-0 overflow-auto border-r border-white/8 px-4 py-4">
                <div className="mb-3 flex items-center justify-between">
                  <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Files</p>
                  <span className="text-xs text-slate-500">{editableFiles.length}</span>
                </div>
                {currentProject ? (
                  <FileTree
                    nodes={currentProject.fileTree}
                    activePath={editorFilePath}
                    onSelect={(filePath) => void handleFileSelect(filePath)}
                  />
                ) : (
                  <p className="text-sm text-slate-500">No project open.</p>
                )}
              </div>

              <div className="min-h-0 overflow-hidden">
                <div className="flex items-center justify-between border-b border-white/8 px-4 py-3">
                  <div>
                    <p className="code-font text-xs uppercase tracking-[0.22em] text-slate-500">
                      {editorFilePath || "No file selected"}
                    </p>
                    <p className="mt-1 text-xs text-slate-500">
                      {editorFilePath ? languageForPath(editorFilePath) : "Select a file to edit"}
                    </p>
                  </div>
                  {currentProject ? (
                    <button
                      className="inline-flex items-center gap-2 rounded-2xl border border-white/8 bg-white/[0.03] px-3 py-2 text-sm text-slate-300 transition hover:bg-white/[0.06]"
                      type="button"
                      onClick={() => void refreshProject(currentProject.project.id, editorFilePath)}
                    >
                      <RefreshCcw className="h-4 w-4" />
                      Refresh
                    </button>
                  ) : null}
                </div>

                <div className="h-[calc(100%-4.5rem)]">
                  {editorFilePath ? (
                    <MonacoEditor
                      height="100%"
                      theme="vs-dark"
                      language={languageForPath(editorFilePath)}
                      value={editorContent}
                      onChange={(value) => setEditorContent(value || "")}
                      options={{
                        minimap: { enabled: false },
                        fontSize: 13,
                        smoothScrolling: true,
                        padding: { top: 18 },
                        wordWrap: "on",
                        scrollBeyondLastLine: false,
                      }}
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center px-6 text-center text-sm text-slate-500">
                      Select a text file from the tree to inspect or edit it with Monaco.
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </main>
  );
}
