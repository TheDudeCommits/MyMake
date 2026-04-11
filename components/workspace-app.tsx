"use client";

import MonacoEditor from "@monaco-editor/react";
import {
  Code2,
  FileCode2,
  FolderKanban,
  Laptop,
  Loader2,
  LogOut,
  MonitorSmartphone,
  MousePointerSquareDashed,
  Paperclip,
  RefreshCcw,
  Save,
  SendHorizonal,
  Smartphone,
  Tablet,
  Trash2,
  Undo2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type {
  AiModelKey,
  AiModelOption,
  AttachmentRecord,
  DashboardSnapshot,
  DevicePreset,
  FileNode,
  ProjectRecord,
  ProjectWorkspace,
  RevisionRecord,
  SelectionPayload,
} from "@/lib/types";

const DEVICE_PRESETS: Record<
  DevicePreset,
  { label: string; width: string; maxWidth: string; icon: typeof Laptop }
> = {
  desktop: { label: "Desktop", width: "100%", maxWidth: "none", icon: Laptop },
  tablet: { label: "Tablet", width: "920px", maxWidth: "100%", icon: Tablet },
  mobile: { label: "Mobile", width: "430px", maxWidth: "100%", icon: Smartphone },
};

const DEVICE_ORDER: DevicePreset[] = ["desktop", "tablet", "mobile"];
const AI_MODEL_STORAGE_KEY = "mymake-selected-ai-model";
const EMPTY_REVISIONS: RevisionRecord[] = [];
const EMPTY_ATTACHMENTS: AttachmentRecord[] = [];

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

function shortAiModelLabel(model: AiModelOption): string {
  if (model.key === "openai-chatgpt-5-2") {
    return "GPT 5.2";
  }

  if (model.key === "anthropic-sonnet-4-6") {
    return "Sonnet 4.6";
  }

  return model.label;
}

function checkpointLabel(revision: RevisionRecord): string {
  return `#${String(revision.sequence + 1).padStart(2, "0")}`;
}

function compactRevisionMessage(value: string): string {
  let normalized = value.replace(/\s+/g, " ").trim();
  const softCutMarkers = [
    ", including ",
    ", removing ",
    ", while ",
    ", across ",
    ", throughout ",
  ];

  for (const marker of softCutMarkers) {
    const index = normalized.toLowerCase().indexOf(marker);
    if (index > 80) {
      normalized = `${normalized.slice(0, index).trimEnd()}.`;
      break;
    }
  }

  if (normalized.length > 150) {
    const trimmed = normalized.slice(0, 147);
    normalized = `${trimmed.slice(0, trimmed.lastIndexOf(" ")).trimEnd()}…`;
  }

  return normalized;
}

function revisionSummaryText(revision: RevisionRecord): string {
  const fallback =
    revision.source === "upload"
      ? "Imported the project and created the first working checkpoint."
      : revision.source === "manual"
        ? "Saved a manual code edit and synced the preview."
        : revision.source === "undo"
          ? "Moved back to an earlier checkpoint."
          : revision.source === "redo"
            ? "Moved forward to a later checkpoint."
            : "Applied a new AI-assisted design change.";

  return compactRevisionMessage(revision.summary || fallback);
}

function revisionPromptText(revision: RevisionRecord): string | null {
  if (revision.source === "ai") {
    return revision.label.trim();
  }

  if (revision.source === "manual") {
    return `Saved ${revision.label.replace(/^Saved\s+/i, "")}`.trim();
  }

  return null;
}

function projectOptionLabel(project: ProjectRecord, duplicateNames: Map<string, number>): string {
  const count = duplicateNames.get(project.name) || 0;
  if (count <= 1) {
    return project.name;
  }

  return `${project.name} · ${project.id.slice(-4)}`;
}

function iconTitle(label: string, disabled?: boolean): string | undefined {
  if (disabled) {
    return undefined;
  }

  return label;
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
  label,
  onClick,
}: {
  active?: boolean;
  children: React.ReactNode;
  disabled?: boolean;
  label: string;
  onClick?: () => void;
}) {
  return (
    <button
      className={clsx(
        "grid h-8 w-8 place-items-center text-slate-400 transition hover:text-white [&_svg]:stroke-[2.35]",
        active && "text-[#d6d8ff]",
        disabled && "cursor-not-allowed opacity-35 hover:text-slate-400",
      )}
      type="button"
      disabled={disabled}
      title={iconTitle(label, disabled)}
      aria-label={label}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function RailIconButton({
  active,
  children,
  label,
  disabled,
  onClick,
}: {
  active?: boolean;
  children: React.ReactNode;
  label: string;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      className={clsx(
        "grid h-8 w-8 place-items-center text-slate-400 transition hover:text-white [&_svg]:stroke-[2.35]",
        active && "text-[#d6d8ff]",
        disabled && "cursor-not-allowed opacity-35 hover:text-slate-400",
      )}
      type="button"
      disabled={disabled}
      title={iconTitle(label, disabled)}
      aria-label={label}
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
  const [selectedAiModelKey, setSelectedAiModelKey] = useState<AiModelKey>(
    initialSnapshot.defaultAiModelKey,
  );
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
  const [isPreviewFrameReady, setIsPreviewFrameReady] = useState(false);
  const [isPreviewSlow, setIsPreviewSlow] = useState(false);

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const leftRailScrollRef = useRef<HTMLDivElement>(null);
  const projectUploadInputRef = useRef<HTMLInputElement>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const previousPreviewIdentityRef = useRef<string | null>(null);
  const previousRevisionIdRef = useRef<string | null>(null);

  const currentProject = snapshot.currentProject;
  const revisions = currentProject?.revisions ?? EMPTY_REVISIONS;
  const orderedRevisions = useMemo(
    () => [...revisions].sort((left, right) => left.sequence - right.sequence),
    [revisions],
  );
  const attachments = currentProject?.attachments ?? EMPTY_ATTACHMENTS;
  const currentDevice = DEVICE_PRESETS[devicePreset];
  const isDesktopPreview = devicePreset === "desktop";
  const displayRoute = routeLabel(currentRoute);
  const hasUnsavedEdits = Boolean(editorFilePath && editorContent !== editorBaselineContent);
  const previewIdentity = currentProject
    ? `${currentProject.project.id}:${currentProject.preview.instanceId ?? "cold"}`
    : null;
  const isPreviewStarting = Boolean(currentProject && currentProject.preview.status === "starting");
  const enabledAiModels = useMemo(
    () => snapshot.aiModels.filter((model) => model.enabled),
    [snapshot.aiModels],
  );
  const fallbackAiModelKey = enabledAiModels[0]?.key || snapshot.defaultAiModelKey;
  const selectedAiModel = useMemo(
    () =>
      snapshot.aiModels.find((model) => model.key === selectedAiModelKey) ||
      snapshot.aiModels.find((model) => model.key === fallbackAiModelKey) ||
      null,
    [fallbackAiModelKey, selectedAiModelKey, snapshot.aiModels],
  );
  const editableFiles = useMemo(
    () =>
      currentProject
        ? flattenFileNodes(currentProject.fileTree).filter(
            (item) => item.type === "file" && item.editable,
          )
        : [],
    [currentProject],
  );
  const currentRevision = useMemo(
    () =>
      currentProject?.project.currentRevisionId
        ? revisions.find((revision) => revision.id === currentProject.project.currentRevisionId) ||
          null
        : null,
    [currentProject?.project.currentRevisionId, revisions],
  );
  const currentCheckpointLabel = currentRevision ? checkpointLabel(currentRevision) : "Version 1";
  const projectNameCounts = useMemo(() => {
    const counts = new Map<string, number>();
    snapshot.projects.forEach((project) => {
      counts.set(project.name, (counts.get(project.name) || 0) + 1);
    });
    return counts;
  }, [snapshot.projects]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const storedModelKey = window.localStorage.getItem(AI_MODEL_STORAGE_KEY) as
      | AiModelKey
      | null;
    if (!storedModelKey) {
      return;
    }

    if (snapshot.aiModels.some((model) => model.key === storedModelKey && model.enabled)) {
      setSelectedAiModelKey(storedModelKey);
    }
  }, [snapshot.aiModels]);

  useEffect(() => {
    if (!snapshot.aiModels.some((model) => model.key === selectedAiModelKey && model.enabled)) {
      setSelectedAiModelKey(fallbackAiModelKey);
    }
  }, [fallbackAiModelKey, selectedAiModelKey, snapshot.aiModels]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(AI_MODEL_STORAGE_KEY, selectedAiModelKey);
  }, [selectedAiModelKey]);

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
    const rail = leftRailScrollRef.current;
    if (!rail) {
      return;
    }

    rail.scrollTop = rail.scrollHeight;
  }, [currentProject?.project.id, currentProject?.project.currentRevisionId, orderedRevisions.length]);

  useEffect(() => {
    if (!previewIdentity) {
      previousPreviewIdentityRef.current = null;
      setIsPreviewFrameReady(false);
      setIsPreviewSlow(false);
      return;
    }

    if (previousPreviewIdentityRef.current === previewIdentity) {
      return;
    }

    previousPreviewIdentityRef.current = previewIdentity;
    setIsPreviewFrameReady(false);
    setIsPreviewSlow(false);

    const timeout = window.setTimeout(() => setIsPreviewSlow(true), 3500);
    return () => window.clearTimeout(timeout);
  }, [previewIdentity]);

  useEffect(() => {
    if (!currentProject?.project.id) {
      previousRevisionIdRef.current = null;
      return;
    }

    const nextRevisionId = currentProject.project.currentRevisionId;
    const previousRevisionId = previousRevisionIdRef.current;
    previousRevisionIdRef.current = nextRevisionId;

    if (
      !nextRevisionId ||
      !previousRevisionId ||
      nextRevisionId === previousRevisionId ||
      !previewIdentity ||
      previousPreviewIdentityRef.current !== previewIdentity
    ) {
      return;
    }

    setIsPreviewFrameReady(false);
    setIsPreviewSlow(false);
    void iframeRef.current?.contentWindow?.location.reload();
  }, [currentProject?.project.currentRevisionId, currentProject?.project.id, previewIdentity]);

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (!event.data || event.data.channel !== "MYMAKE_PREVIEW_BRIDGE") {
        return;
      }

      if (event.data.type === "MYMAKE_SELECT") {
        const payload = event.data.payload as SelectionPayload;
        setSelectedElement(payload);
        setCurrentRoute(payload?.route || "/");
        setIsPicking(false);
        setFeedback(
          payload
            ? `Selected ${payload.tagName.toLowerCase()} on ${payload.route}.`
            : "Selected element is ready for the next AI edit.",
        );
        return;
      }

      if (event.data.type === "MYMAKE_PICKING") {
        setIsPicking(Boolean(event.data.payload?.enabled));
        return;
      }

      if (event.data.type === "MYMAKE_ROUTE" || event.data.type === "MYMAKE_READY") {
        setIsPreviewFrameReady(true);
        setIsPreviewSlow(false);
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

  async function handleDeleteProject() {
    if (!currentProject) {
      return;
    }

    const confirmed = window.confirm(
      `Remove "${currentProject.project.name}" from MyMake? This deletes its uploaded files, checkpoints, and attachments.`,
    );
    if (!confirmed) {
      return;
    }

    try {
      setError(null);
      setFeedback(`Removing ${currentProject.project.name}...`);
      const response = await fetch(`/api/projects/${currentProject.project.id}`, {
        method: "DELETE",
      });
      const data = await readJsonResponse<SnapshotResponse>(response);
      applySnapshot(data);
      setPrompt("");
      setIsPicking(false);
      setIsCodePanelOpen(false);
      setSelectedElement(null);
      setSelectedAttachmentIds([]);
      setFeedback(`Removed ${currentProject.project.name}.`);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Could not remove the project.");
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

    if (!selectedAiModel?.enabled) {
      setError("The selected AI model is not configured yet.");
      return;
    }

    setIsRunningAi(true);
    setError(null);
    setFeedback(`${selectedAiModel.label} is updating the selected UI and refreshing the preview...`);

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
          aiModelKey: selectedAiModel.key,
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
      setError(null);
      setFeedback(action === "undo" ? "Restoring the previous checkpoint..." : "Restoring the next checkpoint...");
      const response = await fetch(`/api/projects/${currentProject.project.id}/history`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action }),
      });
      const data = await readJsonResponse<SnapshotResponse>(response);
      applySnapshot(data);
      setSelectedElement(null);
      setIsPicking(false);
      setFeedback(action === "undo" ? "Moved back to the previous checkpoint." : "Moved forward to the next checkpoint.");
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "History update failed.");
    }
  }

  async function handleRestoreRevision(revision: RevisionRecord) {
    if (!currentProject) {
      return;
    }

    try {
      setError(null);
      setFeedback(`Restoring ${checkpointLabel(revision)}...`);
      const response = await fetch(`/api/projects/${currentProject.project.id}/history`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ revisionId: revision.id }),
      });
      const data = await readJsonResponse<SnapshotResponse>(response);
      applySnapshot(data);
      setSelectedElement(null);
      setIsPicking(false);
      setFeedback(`Restored ${checkpointLabel(revision)}.`);
    } catch (caughtError) {
      setError(
        caughtError instanceof Error ? caughtError.message : "Could not restore this checkpoint.",
      );
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

  const canSendAi = Boolean(
    !isRunningAi &&
      currentProject?.project.currentRevisionId &&
      prompt.trim() &&
      selectedAiModel?.enabled,
  );
  const composerNotice = error || feedback;
  const showPreviewOverlay = Boolean(currentProject && (!isPreviewFrameReady || isPreviewStarting));

  return (
    <main className="h-screen overflow-hidden bg-[#1f2023] text-[#f2f2f4]">
      <div className="flex h-full flex-col">
        <header className="grid h-[60px] shrink-0 grid-cols-[336px_minmax(0,1fr)] border-b border-white/[0.08] bg-[#242528]">
          <div className="flex min-w-0 items-center gap-2 border-r border-white/[0.08] px-3">
            <ToolbarIconButton
              label={isUploading ? "Uploading project" : "Upload project zip"}
              onClick={() => projectUploadInputRef.current?.click()}
            >
              {isUploading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <FolderKanban className="h-4 w-4" />
              )}
            </ToolbarIconButton>

            <div className="relative min-w-0 flex-1">
              <select
                className="h-9 w-full appearance-none rounded-[12px] border border-white/[0.08] bg-[#2a2b2f] px-3 pr-8 text-sm font-medium text-slate-100 outline-none transition hover:bg-[#303238]"
                value={currentProject?.project.id || ""}
                onChange={(event) => void handleProjectChange(event.target.value)}
              >
                <option value="" disabled>
                  Select project
                </option>
                {snapshot.projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {projectOptionLabel(project, projectNameCounts)}
                  </option>
                ))}
              </select>
              <div className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rotate-90 text-slate-500">
                <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5">
                  <path d="M6 3L11 8L6 13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </div>
            </div>

            {currentProject ? (
              <ToolbarIconButton
                label="Delete current project"
                onClick={() => void handleDeleteProject()}
              >
                <Trash2 className="h-4 w-4" />
              </ToolbarIconButton>
            ) : null}

            <span className="text-sm font-medium text-slate-300">
              {currentProject ? currentCheckpointLabel : "No checkpoint"}
            </span>
          </div>

          <div className="flex min-w-0 items-center gap-2 px-4">
            <div className="flex items-center gap-1">
              <ToolbarIconButton
                label="Undo checkpoint"
                disabled={!currentProject}
                onClick={() => void handleHistory("undo")}
              >
                <Undo2 className="h-4 w-4" />
              </ToolbarIconButton>
              <ToolbarIconButton
                label="Redo checkpoint"
                disabled={!currentProject}
                onClick={() => void handleHistory("redo")}
              >
                <RefreshCcw className="h-4 w-4" />
              </ToolbarIconButton>
            </div>

            <div className="ml-2 flex h-9 min-w-0 max-w-[520px] flex-1 items-center rounded-[20px] bg-[#303033] px-4 text-sm text-slate-200">
              <span className="truncate">/ {displayRoute}</span>
            </div>

            <ToolbarIconButton
              label={`Switch device preview (${currentDevice.label})`}
              onClick={cycleDevicePreset}
            >
              <currentDevice.icon className="h-4 w-4" />
            </ToolbarIconButton>

            <div className="ml-auto flex items-center gap-2">
              <div className="grid h-7 w-7 place-items-center rounded-full bg-[#6675a0] text-[12px] font-semibold text-white">
                A
              </div>
              <ToolbarIconButton
                label={isCodePanelOpen ? "Close code panel" : "Open code panel"}
                active={isCodePanelOpen}
                onClick={() => setIsCodePanelOpen((value) => !value)}
              >
                <Code2 className="h-4 w-4" />
              </ToolbarIconButton>
              <ToolbarIconButton label="Sign out" onClick={handleLogout}>
                <LogOut className="h-4 w-4" />
              </ToolbarIconButton>
              <button
                className="h-9 rounded-[12px] border border-white/[0.1] bg-[#2a2b2f] px-4 text-sm font-medium text-slate-100 transition hover:bg-[#303238] disabled:cursor-not-allowed disabled:opacity-50"
                type="button"
                disabled={!currentProject}
                onClick={handlePublish}
              >
                Make a copy
              </button>
              <button
                className="h-9 rounded-[12px] bg-[#5f62ff] px-4 text-sm font-medium text-white transition hover:bg-[#6d70ff]"
                type="button"
                onClick={() => void handleShare()}
              >
                Share
              </button>
            </div>
          </div>
        </header>

        <div className="grid min-h-0 flex-1 grid-cols-[336px_minmax(0,1fr)]">
          <aside className="flex min-h-0 flex-col border-r border-white/[0.08] bg-[#2b2928]">
            <div
              ref={leftRailScrollRef}
              className="mymake-scrollbar-none min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-4"
            >
              <div className="space-y-4">
                <div className="rounded-[16px] border border-white/[0.08] bg-[#2f2d2c] p-3.5">
                  <div className="flex items-start gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-[#8fd08f]">
                        {currentProject?.project.name || "No design project"}
                      </p>
                      <p className="mt-1 text-sm text-[#a1a2a7]">
                        {currentProject ? currentCheckpointLabel : "Upload a project to begin"}
                      </p>
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    {currentProject ? <StatusPill status={currentProject.project.status} /> : null}
                    {currentProject ? (
                      <span className="text-[11px] uppercase tracking-[0.18em] text-slate-500">
                        /{displayRoute}
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-3 rounded-[12px] border border-white/[0.08] bg-[#262628] px-3 py-3">
                    <div className="flex items-center gap-2">
                      <FileCode2 className="h-4 w-4 text-slate-500" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm text-slate-200">{editorFilePath || "No file selected"}</p>
                        <p className="mt-1 text-xs text-slate-500">
                          {editorFilePath
                            ? hasUnsavedEdits
                              ? "Unsaved changes in editor"
                              : "Saved and synced"
                            : "Open the code drawer to edit files"}
                        </p>
                      </div>
                      {hasUnsavedEdits ? (
                        <span className="text-xs font-medium text-[#8fd08f]">+1</span>
                      ) : null}
                    </div>
                  </div>
                </div>

                <div className="rounded-[16px] border border-white/[0.08] bg-[#2f2d2c] px-3.5 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Selected element</p>
                    {selectedElement ? (
                      <span className="rounded-full border border-[#5f62ff]/30 bg-[#5f62ff]/12 px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-slate-100">
                        targeting
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-2 text-sm font-medium text-slate-100">
                    {selectedElement
                      ? `${selectedElement.tagName.toLowerCase()} on ${selectedElement.route}`
                      : "No layer selected yet"}
                  </p>
                  <p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-400">
                    {selectedElement?.textContent ||
                      selectedElement?.domPath ||
                      "Turn on the picker, hover the preview, and click the exact layer you want to edit."}
                  </p>
                </div>

                <div>
                  <div className="flex items-center justify-between gap-3 text-[11px] uppercase tracking-[0.24em] text-slate-500">
                    <div>Conversation</div>
                    <span>{orderedRevisions.length} checkpoints</span>
                  </div>

                  <div className="mt-3 space-y-3">
                    {currentProject ? (
                      orderedRevisions.map((revision) => {
                        const promptText = revisionPromptText(revision);
                        const isCurrentCheckpoint =
                          currentProject.project.currentRevisionId === revision.id;

                        return (
                          <article key={revision.id} className="group space-y-2">
                            {promptText ? (
                              <div className="flex justify-end">
                                <div className="max-w-[88%] rounded-[18px] border border-[#5f62ff]/28 bg-[#5f62ff]/12 px-3.5 py-3 text-left">
                                  <p className="text-sm leading-6 text-white">{promptText}</p>
                                </div>
                              </div>
                            ) : null}

                            <div className="rounded-[18px] border border-white/[0.08] bg-[#2f2d2c] px-3.5 py-3">
                              <div className="flex items-center justify-between gap-3">
                                <span className="rounded-full border border-white/[0.08] bg-[#262628] px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-slate-400">
                                  {checkpointLabel(revision)}
                                </span>
                                {isCurrentCheckpoint ? (
                                  <span className="text-[10px] uppercase tracking-[0.16em] text-emerald-200">
                                    Current
                                  </span>
                                ) : (
                                  <button
                                    className="opacity-0 transition group-hover:opacity-100 text-slate-400 hover:text-white"
                                    type="button"
                                    title={`Restore ${checkpointLabel(revision)}`}
                                    aria-label={`Restore ${checkpointLabel(revision)}`}
                                    onClick={() => void handleRestoreRevision(revision)}
                                  >
                                    <RefreshCcw className="h-3.5 w-3.5" />
                                  </button>
                                )}
                              </div>
                              <p className="mt-2 text-sm leading-6 text-[#e7e7ea]">
                                {revisionSummaryText(revision)}
                              </p>
                            </div>
                          </article>
                        );
                      })
                    ) : (
                      <div className="rounded-[16px] border border-dashed border-white/[0.08] bg-[#2f2d2c]/60 px-3.5 py-4 text-sm leading-6 text-slate-400">
                        Upload a project, make edits, and every change will appear here as a numbered checkpoint with the prompt, concise AI summary, and restore control.
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>

            <div className="shrink-0 border-t border-white/[0.08] bg-[#262524] px-3 pb-3 pt-3">
              {attachments.length ? (
                <div className="mymake-scrollbar-none mb-2 flex max-h-[56px] flex-wrap gap-2 overflow-y-auto pr-1">
                  {attachments.map((attachment) => (
                    <button
                      key={attachment.id}
                      className={clsx(
                        "rounded-full border px-2.5 py-1 text-[11px] transition",
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

              {composerNotice ? (
                <div
                  className={clsx(
                    "mb-2 rounded-[12px] border px-3 py-2 text-xs leading-5",
                    error
                      ? "border-rose-300/15 bg-rose-300/10 text-rose-100"
                      : "border-emerald-300/15 bg-emerald-300/10 text-emerald-100",
                  )}
                >
                  <p className="line-clamp-2">{composerNotice}</p>
                </div>
              ) : null}

              <div className="rounded-[18px] border border-white/[0.08] bg-[#2d2d2f] p-2.5">
                <textarea
                  className="h-[76px] w-full resize-none rounded-[14px] border border-white/[0.08] bg-[#262628] px-3.5 py-3 text-sm leading-6 text-white outline-none transition placeholder:text-slate-500 focus:border-white/[0.18]"
                  placeholder="Ask for changes"
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={(event) => {
                    if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && canSendAi) {
                      event.preventDefault();
                      void handleAiEdit();
                    }
                  }}
                />

                <div className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2">
                  <div className="flex items-center gap-1.5">
                    <RailIconButton
                      label={
                        isUploadingAttachments ? "Uploading attachments" : "Attach files"
                      }
                      onClick={() => attachmentInputRef.current?.click()}
                    >
                      {isUploadingAttachments ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Paperclip className="h-3.5 w-3.5" />
                      )}
                    </RailIconButton>
                    <RailIconButton
                      label={isPicking ? "Disable element picker" : "Enable element picker"}
                      active={isPicking}
                      onClick={() => setIsPicking((value) => !value)}
                    >
                      <MousePointerSquareDashed className="h-3.5 w-3.5" />
                    </RailIconButton>
                  </div>

                  <div className="flex min-w-0 items-center justify-end gap-2">
                    <div className="relative">
                      <select
                        className="h-8 w-[118px] appearance-none rounded-full border border-white/[0.08] bg-[#262628] px-3 pr-8 text-[11px] text-slate-300 outline-none transition hover:bg-[#303238]"
                        value={selectedAiModel?.key || fallbackAiModelKey}
                        onChange={(event) =>
                          setSelectedAiModelKey(event.target.value as AiModelKey)
                        }
                        title={selectedAiModel?.label || ""}
                      >
                        {snapshot.aiModels.map((model) => (
                          <option key={model.key} value={model.key} disabled={!model.enabled}>
                            {model.enabled
                              ? shortAiModelLabel(model)
                              : `${shortAiModelLabel(model)} (Needs key)`}
                          </option>
                        ))}
                      </select>
                      <div className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rotate-90 text-slate-500">
                        <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5">
                          <path d="M6 3L11 8L6 13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </div>
                    </div>
                    <button
                      className="grid h-9 w-9 shrink-0 place-items-center text-[#7f82ff] transition hover:text-[#9799ff] disabled:cursor-not-allowed disabled:text-slate-500"
                      type="button"
                      disabled={!canSendAi}
                      title={canSendAi ? "Send AI edit" : undefined}
                      aria-label="Send AI edit"
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
            </div>
          </aside>

          <section className="relative min-h-0 flex-1 overflow-hidden mymake-grid-canvas">
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_34%_18%,rgba(89,97,180,0.13),transparent_24%),radial-gradient(circle_at_70%_52%,rgba(255,255,255,0.02),transparent_28%)]" />

            <div
              className={clsx(
                "relative flex h-full",
                isDesktopPreview
                  ? "items-stretch justify-stretch p-0"
                  : "items-start justify-center px-2 pb-2 pt-2",
              )}
            >
              {currentProject ? (
                <div
                  className={clsx(
                    "mymake-scrollbar-none flex h-full w-full overflow-auto",
                    isDesktopPreview ? "items-stretch justify-stretch" : "items-start justify-center",
                  )}
                >
                  <div
                    className="relative transition-all duration-300"
                    style={{
                      width: currentDevice.width,
                      maxWidth: currentDevice.maxWidth,
                      height: isDesktopPreview ? "100%" : undefined,
                    }}
                  >
                    <iframe
                      key={`${currentProject.project.id}-${currentProject.preview.instanceId ?? "cold"}`}
                      ref={iframeRef}
                      title={`${currentProject.project.name} preview`}
                      src={`${currentProject.preview.url}/`}
                      className={clsx(
                        "w-full bg-[#12141a]",
                        isDesktopPreview
                          ? "h-full min-h-0 border-0 shadow-none"
                          : "h-[calc(100vh-76px)] min-h-[620px] rounded-[20px] border border-white/[0.06] shadow-[0_30px_60px_rgba(0,0,0,0.22)]",
                      )}
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
                    {showPreviewOverlay ? (
                      <div
                        className={clsx(
                          "pointer-events-none absolute inset-0 grid place-items-center bg-[linear-gradient(180deg,rgba(15,16,20,0.08),rgba(15,16,20,0.42))]",
                          !isDesktopPreview && "rounded-[20px]",
                        )}
                      >
                        <div className="pointer-events-auto w-[min(420px,calc(100%-32px))] rounded-[22px] border border-white/[0.08] bg-[#17191f]/95 px-6 py-5 text-left shadow-[0_20px_60px_rgba(0,0,0,0.32)] backdrop-blur">
                          <div className="flex items-center gap-3">
                            <div className="grid h-10 w-10 place-items-center rounded-full bg-[#232737] text-[#cfd6ff]">
                              <Loader2 className="h-4 w-4 animate-spin" />
                            </div>
                            <div>
                              <p className="text-sm font-medium text-white">
                                {isPreviewSlow
                                  ? "Reconnecting the live preview"
                                  : "Warming the live preview"}
                              </p>
                              <p className="mt-1 text-xs leading-5 text-slate-400">
                                {isPreviewSlow
                                  ? "The runner is taking longer than usual. MyMake is keeping the connection alive and will recover automatically."
                                  : "Keeping the preview runner hot so edits can appear without a full workspace refresh."}
                              </p>
                            </div>
                          </div>
                          {isPreviewSlow ? (
                            <div className="mt-4 flex items-center gap-2">
                              <button
                                className="rounded-full border border-white/[0.08] bg-[#232737] px-3 py-1.5 text-xs font-medium text-slate-100 transition hover:bg-[#2b3045]"
                                type="button"
                                onClick={() => {
                                  setIsPreviewFrameReady(false);
                                  setIsPreviewSlow(false);
                                  void refreshProject(currentProject.project.id, editorFilePath);
                                  void iframeRef.current?.contentWindow?.location.reload();
                                }}
                              >
                                Reconnect preview
                              </button>
                              <span className="text-[11px] text-slate-500">
                                The current runner stays alive in the background.
                              </span>
                            </div>
                          ) : null}
                        </div>
                      </div>
                    ) : null}
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
                    Upload a React app zip from the toolbar to open the same Figma Make style workspace shown in your screenshot.
                  </p>
                </div>
              )}
            </div>

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
                      <button
                        className="inline-flex h-8 items-center rounded-[10px] border border-white/[0.08] bg-[#2a2b2f] px-3 text-sm text-slate-300 transition hover:bg-[#34353b] disabled:cursor-not-allowed disabled:opacity-45"
                        type="button"
                        disabled={!editorFilePath || !hasUnsavedEdits}
                        onClick={handleDiscard}
                      >
                        Discard
                      </button>
                      <ToolbarIconButton label="Close code panel" onClick={() => setIsCodePanelOpen(false)}>
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
