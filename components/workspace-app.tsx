"use client";

import MonacoEditor from "@monaco-editor/react";
import {
  Code2,
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

const DEVICE_PRESETS: Record<DevicePreset, { label: string; width: string; icon: typeof Laptop }> =
  {
    desktop: { label: "Desktop", width: "1080px", icon: Laptop },
    tablet: { label: "Tablet", width: "840px", icon: Tablet },
    mobile: { label: "Mobile", width: "402px", icon: Smartphone },
  };

const DEVICE_ORDER: DevicePreset[] = ["desktop", "tablet", "mobile"];

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

function shortenPath(filePath: string | null) {
  if (!filePath) {
    return "No file selected";
  }

  const parts = filePath.split("/");
  if (parts.length <= 2) {
    return filePath;
  }

  return `${parts[0]}/.../${parts.at(-1)}`;
}

function routeLabel(route: string) {
  if (route === "/") {
    return "home";
  }

  return route.replace(/^\/+/, "") || "home";
}

function StatusPill({ status }: { status: ProjectWorkspace["project"]["status"] }) {
  const styles =
    status === "ready"
      ? "border-emerald-300/20 bg-emerald-300/10 text-emerald-100"
      : status === "installing"
        ? "border-amber-300/20 bg-amber-300/10 text-amber-100"
        : "border-rose-300/20 bg-rose-300/10 text-rose-100";

  return (
    <span
      className={clsx(
        "rounded-full border px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.18em]",
        styles,
      )}
    >
      {status}
    </span>
  );
}

function ToolbarIconButton({
  active,
  children,
  disabled,
  onClick,
}: {
  active?: boolean;
  children: React.ReactNode;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      className={clsx(
        "grid h-8 w-8 place-items-center rounded-[10px] border text-slate-200 transition",
        active
          ? "border-[#5f62ff]/40 bg-[#5f62ff]/14 text-white"
          : "border-white/[0.08] bg-[#2a2b2f] hover:bg-[#303238]",
        disabled && "cursor-not-allowed opacity-45 hover:bg-[#2a2b2f]",
      )}
      type="button"
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function RailIconButton({
  active,
  children,
  onClick,
}: {
  active?: boolean;
  children: React.ReactNode;
  onClick?: () => void;
}) {
  return (
    <button
      className={clsx(
        "grid h-8 w-8 place-items-center rounded-full border text-slate-300 transition",
        active
          ? "border-[#5f62ff]/40 bg-[#5f62ff]/14 text-white"
          : "border-white/[0.08] bg-[#303033] hover:bg-[#3a3a3f]",
      )}
      type="button"
      onClick={onClick}
    >
      {children}
    </button>
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
          <ChevronSmall open={open} />
          <FolderKanban className="h-4 w-4 text-slate-500" />
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
          ? "bg-[#34353b] text-white"
          : "text-slate-300 hover:bg-white/5",
      )}
      type="button"
      onClick={() => onSelect(node.path)}
    >
      <FileCode2 className="h-4 w-4 text-slate-500" />
      <span className="truncate">{node.name}</span>
      {!node.editable ? (
        <span className="ml-auto rounded-full border border-white/10 px-2 py-0.5 text-[10px] uppercase tracking-[0.2em] text-slate-500">
          view
        </span>
      ) : null}
    </button>
  );
}

function ChevronSmall({ open }: { open: boolean }) {
  return (
    <div
      className={clsx(
        "h-4 w-4 text-slate-500 transition-transform",
        open ? "rotate-90" : "rotate-0",
      )}
    >
      <svg viewBox="0 0 16 16" fill="none" className="h-full w-full">
        <path d="M6 3L11 8L6 13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

export function WorkspaceApp({ initialSnapshot }: { initialSnapshot: DashboardSnapshot }) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [devicePreset, setDevicePreset] = useState<DevicePreset>("desktop");
  const [isPicking, setIsPicking] = useState(false);
  const [isCodePanelOpen, setIsCodePanelOpen] = useState(false);
  const [selectedElement, setSelectedElement] = useState<SelectionPayload | null>(null);
  const [currentRoute, setCurrentRoute] = useState("/");
  const [prompt, setPrompt] = useState("");
  const [editorFilePath, setEditorFilePath] = useState<string | null>(
    initialSnapshot.currentProject?.currentFilePath || null,
  );
  const [editorContent, setEditorContent] = useState(
    initialSnapshot.currentProject?.currentFileContent || "",
  );
  const [editorBaselineContent, setEditorBaselineContent] = useState(
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
  const currentDevice = DEVICE_PRESETS[devicePreset];
  const previewWidth = currentDevice.width;
  const displayRoute = routeLabel(currentRoute);
  const hasUnsavedEdits = Boolean(editorFilePath && editorContent !== editorBaselineContent);
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
    setEditorBaselineContent(currentProject?.currentFileContent || "");
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
      setFeedback(`Imported ${file.name} and matched it to the live canvas.`);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Upload failed.");
    } finally {
      setIsUploading(false);
    }
  }

  async function handleProjectChange(projectId: string) {
    if (!projectId) {
      return;
    }

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
      setEditorBaselineContent(payload.content);
      setFeedback(`Opened ${payload.path}`);
      setIsCodePanelOpen(true);
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

  async function handleShare() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setFeedback("Copied the current MyMake URL to your clipboard.");
    } catch {
      setError("Could not copy the share link.");
    }
  }

  function handlePublish() {
    if (!currentProject) {
      return;
    }

    window.open(
      `/api/projects/${currentProject.project.id}/export`,
      "_blank",
      "noopener,noreferrer",
    );
    setFeedback("Preparing the current code snapshot for download.");
  }

  function handleDiscard() {
    setEditorContent(editorBaselineContent);
    if (editorFilePath) {
      setFeedback(`Discarded unsaved changes in ${editorFilePath}.`);
    }
  }

  function cycleDevicePreset() {
    const currentIndex = DEVICE_ORDER.indexOf(devicePreset);
    const nextPreset = DEVICE_ORDER[(currentIndex + 1) % DEVICE_ORDER.length];
    setDevicePreset(nextPreset);
  }

  function toggleAttachmentSelection(attachmentId: string) {
    setSelectedAttachmentIds((previous) =>
      previous.includes(attachmentId)
        ? previous.filter((value) => value !== attachmentId)
        : [...previous, attachmentId],
    );
  }

  const briefingBullets = useMemo(() => {
    if (!currentProject) {
      return [
        "Upload a React app export to start a live preview canvas and prompt-driven editing flow.",
        "Use the toolbar to switch device sizes, open the code drawer, or publish the current snapshot.",
      ];
    }

    const bullets = [
      `Preview is live for ${currentProject.project.name} and currently focused on /${displayRoute}.`,
      selectedElement
        ? `The next AI change will target ${selectedElement.tagName.toLowerCase()} on ${selectedElement.route}.`
        : "Enable the eye tool and click an element in the canvas to target a specific layer.",
    ];

    if (feedback) {
      bullets.unshift(feedback);
    }

    return bullets;
  }, [currentProject, displayRoute, feedback, selectedElement]);

  const explorationBullets = useMemo(() => {
    if (!currentProject) {
      return [
        "Drop in a Next.js or Vite React zip from the upload button in the header.",
        "Keep the code drawer closed for the cleaner Figma Make canvas view from the screenshot.",
      ];
    }

    return [
      attachments.length
        ? `${attachments.length} reference file${attachments.length === 1 ? "" : "s"} are ready for the next prompt.`
        : "Attach screenshots, brand guides, or reference files to ground your next AI request.",
      `${revisions.length} revision${revisions.length === 1 ? "" : "s"} are stored for undo and redo.`,
    ];
  }, [attachments.length, currentProject, revisions.length]);

  return (
    <main className="h-screen overflow-hidden bg-[#1f2023] text-[#f2f2f4]">
      <div className="flex h-full flex-col">
        <header className="border-b border-white/[0.08] bg-[#242528]">
          <div className="flex h-14 items-center gap-2 px-3">
            <ToolbarIconButton onClick={() => projectUploadInputRef.current?.click()}>
              {isUploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            </ToolbarIconButton>

            <div className="relative">
              <select
                className="h-8 min-w-[160px] appearance-none rounded-[10px] border border-white/[0.08] bg-[#2a2b2f] px-3 pr-8 text-sm font-medium text-slate-100 outline-none transition hover:bg-[#303238]"
                value={currentProject?.project.id || ""}
                onChange={(event) => void handleProjectChange(event.target.value)}
              >
                <option value="" disabled>
                  Select project
                </option>
                {snapshot.projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
              <div className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rotate-90 text-slate-500">
                <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5">
                  <path d="M6 3L11 8L6 13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </div>
            </div>

            <div className="rounded-[8px] border border-white/[0.08] bg-[#2a2b2f] px-2 py-1 text-[11px] uppercase tracking-[0.16em] text-slate-300">
              AI
            </div>

            <button
              className="inline-flex h-8 items-center gap-2 rounded-[10px] border border-white/[0.08] bg-[#2a2b2f] px-3 text-sm text-slate-300 transition hover:bg-[#303238]"
              type="button"
            >
              Version 1
              <div className="rotate-90 text-slate-500">
                <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5">
                  <path d="M6 3L11 8L6 13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </div>
            </button>

            <div className="ml-3 flex items-center gap-1">
              <ToolbarIconButton active={isPicking} onClick={() => setIsPicking((value) => !value)}>
                <Eye className="h-4 w-4" />
              </ToolbarIconButton>
              <ToolbarIconButton disabled={!currentProject} onClick={() => void handleHistory("undo")}>
                <Undo2 className="h-4 w-4" />
              </ToolbarIconButton>
              <ToolbarIconButton disabled={!currentProject} onClick={() => void handleHistory("redo")}>
                <RefreshCcw className="h-4 w-4" />
              </ToolbarIconButton>
            </div>

            <div className="ml-1 flex h-8 min-w-[198px] items-center gap-2 rounded-[10px] border border-white/[0.08] bg-[#2a2b2f] px-3 text-sm text-slate-300">
              <RefreshCcw className="h-3.5 w-3.5 text-slate-500" />
              <span className="truncate">/ {displayRoute}</span>
            </div>

            <ToolbarIconButton onClick={cycleDevicePreset}>
              <currentDevice.icon className="h-4 w-4" />
            </ToolbarIconButton>

            <div className="ml-auto flex items-center gap-2">
              <div className="grid h-7 w-7 place-items-center rounded-full bg-[#6675a0] text-[12px] font-semibold text-white">
                A
              </div>
              <ToolbarIconButton active={isCodePanelOpen} onClick={() => setIsCodePanelOpen((value) => !value)}>
                <Code2 className="h-4 w-4" />
              </ToolbarIconButton>
              <ToolbarIconButton onClick={handleLogout}>
                <LogOut className="h-4 w-4" />
              </ToolbarIconButton>
              <button
                className="h-8 rounded-[10px] border border-white/[0.1] bg-[#2a2b2f] px-4 text-sm font-medium text-slate-100 transition hover:bg-[#303238] disabled:cursor-not-allowed disabled:opacity-50"
                type="button"
                disabled={!currentProject}
                onClick={handlePublish}
              >
                Publish
              </button>
              <button
                className="h-8 rounded-[10px] bg-[#5f62ff] px-4 text-sm font-medium text-white transition hover:bg-[#6d70ff]"
                type="button"
                onClick={() => void handleShare()}
              >
                Share
              </button>
            </div>
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
          <aside className="flex w-[272px] min-h-0 flex-col border-r border-white/[0.08] bg-[#2b2928]">
            <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-3">
              <div className="space-y-1.5 text-[12px] leading-8 text-[#d9d9de]">
                {briefingBullets.map((bullet) => (
                  <div key={bullet} className="flex gap-2">
                    <span className="pt-[5px] text-[9px] text-[#b2b2b7]">•</span>
                    <p>{bullet}</p>
                  </div>
                ))}
              </div>

              <p className="mt-4 text-[12px] leading-6 text-[#d9d9de]">Next steps you could explore:</p>
              <div className="mt-1.5 space-y-1.5 text-[12px] leading-8 text-[#d9d9de]">
                {explorationBullets.map((bullet) => (
                  <div key={bullet} className="flex gap-2">
                    <span className="pt-[5px] text-[9px] text-[#b2b2b7]">•</span>
                    <p>{bullet}</p>
                  </div>
                ))}
              </div>

              <div className="mt-4 rounded-[16px] border border-white/[0.08] bg-[#2f2d2c] p-3.5">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium text-[#8fd08f]">
                      {currentProject?.project.name || "No design project"}
                    </p>
                    <p className="mt-1 text-sm text-[#a1a2a7]">Version 1</p>
                  </div>
                  <button
                    className="rounded-full px-2 py-1 text-sm text-slate-400 transition hover:bg-white/[0.06]"
                    type="button"
                    onClick={() => setIsCodePanelOpen((value) => !value)}
                  >
                    ...
                  </button>
                </div>
                <div className="mt-3 flex items-center gap-2">
                  {currentProject ? <StatusPill status={currentProject.project.status} /> : null}
                  {currentProject ? (
                    <span className="text-[11px] uppercase tracking-[0.18em] text-slate-500">
                      {formatTimestamp(currentProject.project.lastOpenedAt)}
                    </span>
                  ) : null}
                </div>
              </div>

              <div className="mt-3.5 flex items-center gap-3 text-slate-500">
                <RailIconButton>
                  <Sparkles className="h-3.5 w-3.5" />
                </RailIconButton>
                <RailIconButton>
                  <Undo2 className="h-3.5 w-3.5" />
                </RailIconButton>
                <RailIconButton>
                  <RefreshCcw className="h-3.5 w-3.5" />
                </RailIconButton>
              </div>

              <div className="mt-4 rounded-[16px] border border-white/[0.08] bg-[#2f2d2c] p-3.5">
                <div className="flex items-center justify-between gap-3 text-sm text-slate-200">
                  <div className="flex items-center gap-2">
                    <Code2 className="h-4 w-4 text-slate-400" />
                    <span>{editorFilePath ? "1 edited file" : "No edited file"}</span>
                  </div>
                  <button
                    className="rounded-full px-2 py-1 text-slate-500 transition hover:bg-white/[0.06]"
                    type="button"
                    onClick={() => setIsCodePanelOpen((value) => !value)}
                  >
                    <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5">
                      <path d="M6 3L11 8L6 13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                </div>

                <div className="mt-4 rounded-[12px] border border-white/[0.08] bg-[#262628] px-3 py-3">
                  <div className="flex items-center gap-2">
                    <FileCode2 className="h-4 w-4 text-slate-400" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-slate-200">{editorFilePath || "No file selected"}</p>
                      <p className="mt-1 text-xs text-slate-500">
                        {editorFilePath ? (hasUnsavedEdits ? "Unsaved changes" : "Saved") : "Open a file to edit it here"}
                      </p>
                    </div>
                    {hasUnsavedEdits ? (
                      <span className="text-xs font-medium text-[#8fd08f]">+1</span>
                    ) : null}
                  </div>
                </div>

                <div className="mt-4 flex items-center gap-2">
                  <button
                    className="rounded-[8px] bg-[#5f62ff] px-3 py-2 text-sm font-medium text-white transition hover:bg-[#6d70ff] disabled:cursor-not-allowed disabled:opacity-50"
                    type="button"
                    disabled={isSaving || !editorFilePath || !hasUnsavedEdits}
                    onClick={() => void handleSave()}
                  >
                    {isSaving ? "Saving..." : "Save"}
                  </button>
                  <button
                    className="rounded-[8px] border border-white/[0.1] bg-[#2a2b2f] px-3 py-2 text-sm text-slate-300 transition hover:bg-[#34353b] disabled:cursor-not-allowed disabled:opacity-50"
                    type="button"
                    disabled={!editorFilePath || !hasUnsavedEdits}
                    onClick={handleDiscard}
                  >
                    Discard
                  </button>
                </div>
              </div>
            </div>

            <div className="border-t border-white/[0.08] bg-[#262524] p-3">
              {attachments.length ? (
                <div className="mb-3 flex flex-wrap gap-2">
                  {attachments.map((attachment) => (
                    <button
                      key={attachment.id}
                      className={clsx(
                        "rounded-full border px-3 py-1.5 text-[11px] transition",
                        selectedAttachmentIds.includes(attachment.id)
                          ? "border-[#5f62ff]/40 bg-[#5f62ff]/14 text-white"
                          : "border-white/[0.08] bg-[#2f2f33] text-slate-300 hover:bg-[#383940]",
                      )}
                      type="button"
                      onClick={() => toggleAttachmentSelection(attachment.id)}
                    >
                      {attachment.filename}
                    </button>
                  ))}
                </div>
              ) : null}

              {feedback ? (
                <div className="mb-3 rounded-[12px] border border-emerald-300/15 bg-emerald-300/10 px-3 py-2 text-xs leading-5 text-emerald-100">
                  {feedback}
                </div>
              ) : null}

              {error ? (
                <div className="mb-3 rounded-[12px] border border-rose-300/15 bg-rose-300/10 px-3 py-2 text-xs leading-5 text-rose-100">
                  {error}
                </div>
              ) : null}

              <textarea
                className="min-h-[122px] w-full resize-none rounded-[16px] border border-white/[0.08] bg-[#2f2f31] px-4 py-3 text-sm leading-6 text-white outline-none transition placeholder:text-slate-500 focus:border-white/[0.18]"
                placeholder="Ask for changes"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
              />

              <div className="mt-3 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <RailIconButton onClick={() => projectUploadInputRef.current?.click()}>
                    <Upload className="h-3.5 w-3.5" />
                  </RailIconButton>
                  <RailIconButton onClick={() => attachmentInputRef.current?.click()}>
                    {isUploadingAttachments ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <ImagePlus className="h-3.5 w-3.5" />
                    )}
                  </RailIconButton>
                  <RailIconButton active={isPicking} onClick={() => setIsPicking((value) => !value)}>
                    <MousePointerSquareDashed className="h-3.5 w-3.5" />
                  </RailIconButton>
                  <RailIconButton active={isCodePanelOpen} onClick={() => setIsCodePanelOpen((value) => !value)}>
                    <Code2 className="h-3.5 w-3.5" />
                  </RailIconButton>
                </div>

                <div className="flex items-center gap-2">
                  <div className="rounded-full border border-white/[0.08] bg-[#2f2f31] px-3 py-1 text-[11px] text-slate-300">
                    Claude Sonnet 4
                  </div>
                  <button
                    className="grid h-8 w-8 place-items-center rounded-full bg-[#6467ff] text-white transition hover:bg-[#7073ff] disabled:cursor-not-allowed disabled:opacity-45"
                    type="button"
                    disabled={isRunningAi || !currentProject?.project.currentRevisionId || !prompt.trim()}
                    onClick={() => void handleAiEdit()}
                  >
                    {isRunningAi ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <SendHorizonal className="h-3.5 w-3.5" />
                    )}
                  </button>
                </div>
              </div>
            </div>
          </aside>

          <section className="relative min-h-0 flex-1 overflow-hidden mymake-grid-canvas">
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_34%_18%,rgba(89,97,180,0.13),transparent_24%),radial-gradient(circle_at_70%_52%,rgba(255,255,255,0.02),transparent_28%)]" />

            <div className="relative flex h-full items-center justify-center px-10 pb-10 pt-8">
              {currentProject ? (
                <div className="flex h-full w-full items-center justify-center overflow-auto">
                  <div
                    className="transition-all duration-300"
                    style={{
                      width: previewWidth,
                      maxWidth: "100%",
                    }}
                  >
                    <iframe
                      key={`${currentProject.project.id}-${currentProject.project.currentRevisionId}-${devicePreset}`}
                      ref={iframeRef}
                      title={`${currentProject.project.name} preview`}
                      src={`${currentProject.preview.url}/`}
                      className="h-[calc(100vh-126px)] min-h-[620px] w-full rounded-[18px] border border-white/[0.06] bg-white shadow-[0_30px_60px_rgba(0,0,0,0.22)]"
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
                </div>
              ) : (
                <div className="max-w-xl text-center">
                  <div className="mx-auto grid h-20 w-20 place-items-center rounded-[24px] border border-white/[0.08] bg-white/[0.04] text-slate-200">
                    <MonitorSmartphone className="h-8 w-8" />
                  </div>
                  <h2 className="mt-6 text-[42px] font-medium tracking-[-0.06em] text-white">
                    Import your first design project
                  </h2>
                  <p className="mt-4 text-base leading-8 text-slate-400">
                    Upload a React app zip from the toolbar or prompt rail to open the same Figma Make style workspace shown in your screenshot.
                  </p>
                </div>
              )}
            </div>

            <button
              className="absolute bottom-4 right-4 grid h-8 w-8 place-items-center rounded-full border border-white/[0.1] bg-[#2a2b2f] text-sm text-slate-300 transition hover:bg-[#34353b]"
              type="button"
            >
              ?
            </button>

            {isCodePanelOpen ? (
              <>
                <div
                  className="absolute inset-0 z-20 bg-black/18"
                  onClick={() => setIsCodePanelOpen(false)}
                />
                <aside className="absolute inset-y-0 right-0 z-30 flex w-[520px] flex-col border-l border-white/[0.08] bg-[#1f2024]/98 shadow-[-30px_0_60px_rgba(0,0,0,0.3)] backdrop-blur-md">
                  <div className="flex items-center justify-between border-b border-white/[0.08] px-4 py-4">
                    <div>
                      <p className="text-[11px] uppercase tracking-[0.24em] text-slate-500">Manual edits</p>
                      <p className="mt-1 text-base font-medium text-white">
                        {shortenPath(editorFilePath)}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {currentProject ? (
                        <button
                          className="inline-flex h-8 items-center gap-2 rounded-[10px] border border-white/[0.08] bg-[#2a2b2f] px-3 text-sm text-slate-300 transition hover:bg-[#34353b]"
                          type="button"
                          onClick={() => void refreshProject(currentProject.project.id, editorFilePath)}
                        >
                          <RefreshCcw className="h-4 w-4" />
                          Refresh
                        </button>
                      ) : null}
                      <button
                        className="inline-flex h-8 items-center gap-2 rounded-[10px] border border-white/[0.08] bg-[#2a2b2f] px-3 text-sm text-slate-300 transition hover:bg-[#34353b] disabled:cursor-not-allowed disabled:opacity-45"
                        type="button"
                        disabled={isSaving || !editorFilePath || !hasUnsavedEdits}
                        onClick={() => void handleSave()}
                      >
                        {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                        Save
                      </button>
                      <ToolbarIconButton onClick={() => setIsCodePanelOpen(false)}>
                        <Code2 className="h-4 w-4" />
                      </ToolbarIconButton>
                    </div>
                  </div>

                  <div className="grid min-h-0 flex-1 grid-cols-[220px_minmax(0,1fr)]">
                    <div className="min-h-0 overflow-auto border-r border-white/[0.08] px-3 py-4">
                      <div className="mb-3 flex items-center justify-between">
                        <p className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Files</p>
                        <span className="text-[11px] text-slate-500">{editableFiles.length}</span>
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
                      <div className="flex items-center justify-between border-b border-white/[0.08] px-4 py-3">
                        <div>
                          <p className="text-[11px] uppercase tracking-[0.22em] text-slate-500">
                            {editorFilePath || "No file selected"}
                          </p>
                          <p className="mt-1 text-[11px] text-slate-500">
                            {editorFilePath ? languageForPath(editorFilePath) : "Select a file to edit"}
                          </p>
                        </div>
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
                </aside>
              </>
            ) : null}
          </section>
        </div>
      </div>

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
    </main>
  );
}
