"use client";

import MonacoEditor from "@monaco-editor/react";
import {
  Bell,
  ChevronDown,
  Code2,
  Clock3,
  Download,
  ExternalLink,
  FileCode2,
  FolderKanban,
  FolderOpen,
  Grid2x2,
  House,
  Laptop,
  Loader2,
  LogOut,
  MonitorSmartphone,
  MousePointerSquareDashed,
  Paperclip,
  Plus,
  RefreshCcw,
  Save,
  Search,
  SendHorizonal,
  Smartphone,
  Sparkles,
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
const HOME_RESOURCE_CARDS = [
  {
    title: "Mobile Strategy Review",
    subtitle: "Recommended from Community",
    background:
      "linear-gradient(135deg, rgba(18,19,28,0.98), rgba(72,106,255,0.72) 68%, rgba(132,204,255,0.38))",
  },
  {
    title: "User Journey Map Template",
    subtitle: "Recommended from Community",
    background:
      "linear-gradient(135deg, rgba(72,58,217,0.88), rgba(115,103,255,0.92) 52%, rgba(195,161,255,0.58))",
  },
  {
    title: "Website mockup blueprint",
    subtitle: "Recommended from Community",
    background:
      "linear-gradient(135deg, rgba(246,246,248,0.96), rgba(221,223,229,0.94) 72%, rgba(193,196,205,0.9))",
  },
  {
    title: "Our Blooms Brand Study",
    subtitle: "Recommended from Community",
    background:
      "linear-gradient(135deg, rgba(47,40,62,0.96), rgba(196,127,255,0.72) 50%, rgba(255,218,234,0.7))",
  },
] as const;

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

function selectedElementTitle(selection: SelectionPayload | null): string {
  if (!selection) {
    return "No layer selected yet";
  }

  const label = selection.nearestFramerName || selection.tagName.toLowerCase();
  return `${label} on ${selection.route}`;
}

function selectedElementSummary(selection: SelectionPayload | null): string {
  if (!selection) {
    return "Turn on the picker, hover the preview, and click the exact layer you want to edit.";
  }

  return (
    selection.textContent ||
    selection.nearestFramerName ||
    selection.scopedSelector ||
    selection.selector ||
    selection.domPath
  );
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

function projectMonogram(projectName: string): string {
  const normalized = projectName
    .replace(/\.[a-z0-9]+$/i, "")
    .split(/[\s_-]+/)
    .filter(Boolean)
    .slice(0, 3)
    .map((part) => part[0]?.toUpperCase() || "")
    .join("");

  return normalized || "MM";
}

function projectCardBackground(project: ProjectRecord): string {
  const seed = Array.from(project.id).reduce(
    (total, character, index) => total + character.charCodeAt(0) * (index + 7),
    0,
  );
  const hue = seed % 360;
  const hueAlt = (hue + 48) % 360;

  return `radial-gradient(circle at 18% 16%, hsla(${hue}, 90%, 72%, 0.28), transparent 28%), radial-gradient(circle at 84% 78%, hsla(${hueAlt}, 90%, 72%, 0.22), transparent 24%), linear-gradient(180deg, rgba(22,24,30,0.96) 0%, rgba(18,19,24,0.98) 100%)`;
}

function relativeProjectTime(value: string): string {
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) {
    return "Updated recently";
  }

  const minutes = Math.max(1, Math.round((Date.now() - timestamp) / 60000));
  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }

  const days = Math.round(hours / 24);
  if (days < 7) {
    return `${days}d ago`;
  }

  const weeks = Math.round(days / 7);
  return `${weeks}w ago`;
}

function projectStatusText(status: ProjectRecord["status"]): string {
  if (status === "ready") {
    return "Ready";
  }

  if (status === "installing") {
    return "Building";
  }

  if (status === "unsupported") {
    return "Unsupported";
  }

  return "Needs attention";
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

function UserBadgeButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      className="group relative grid h-8 w-8 place-items-center rounded-full bg-[#6675a0] text-white transition hover:bg-[#7787b6]"
      type="button"
      title="Sign out"
      aria-label="Sign out"
      onClick={onClick}
    >
      <span className="text-[12px] font-semibold transition group-hover:opacity-0">A</span>
      <LogOut className="absolute h-4 w-4 opacity-0 transition group-hover:opacity-100" />
    </button>
  );
}

function HomeProjectCard({
  project,
  label,
  onDelete,
  onOpen,
}: {
  project: ProjectRecord;
  label: string;
  onDelete: (project: ProjectRecord) => void;
  onOpen: (projectId: string) => void;
}) {
  return (
    <article className="group relative overflow-hidden rounded-[24px] border border-white/[0.08] bg-[#2a2b2f] text-left transition hover:border-white/[0.16] hover:bg-[#2d2e33]">
      <div
        className="relative h-[214px] overflow-hidden rounded-[22px] rounded-b-[12px] border-b border-white/[0.06] p-5"
        style={{ background: projectCardBackground(project) }}
      >
        <div className="absolute inset-0 opacity-60" />
        <div className="relative z-10 flex items-start justify-between gap-3">
          <span className="rounded-full border border-white/[0.12] bg-black/20 px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.18em] text-white/72">
            {projectStatusText(project.status)}
          </span>
          <button
            className="grid h-8 w-8 place-items-center rounded-full bg-black/24 text-white/68 opacity-70 transition hover:bg-black/40 hover:text-white group-hover:opacity-100"
            type="button"
            title={`Delete ${label}`}
            aria-label={`Delete ${label}`}
            onClick={() => onDelete(project)}
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>

        <button
          className="relative z-10 mt-6 flex h-[calc(100%-56px)] w-full flex-col justify-end text-left"
          type="button"
          onClick={() => onOpen(project.id)}
        >
          <div className="space-y-3">
            <div className="inline-flex h-12 min-w-[72px] items-center justify-center rounded-[16px] border border-white/[0.08] bg-black/22 px-4 text-[28px] font-semibold tracking-[-0.06em] text-white/92">
              {projectMonogram(label)}
            </div>
            <div className="max-w-[78%] text-[30px] font-semibold leading-none tracking-[-0.06em] text-white">
              {label}
            </div>
          </div>
        </button>
      </div>

      <button
        className="block w-full text-left"
        type="button"
        onClick={() => onOpen(project.id)}
      >
        <div className="flex items-center justify-between gap-4 px-4 py-4">
          <div className="min-w-0">
            <p className="truncate text-[15px] font-medium text-white">{label}</p>
            <p className="mt-1 text-sm text-slate-400">Edited {relativeProjectTime(project.lastOpenedAt)}</p>
          </div>
          <ExternalLink className="h-4 w-4 shrink-0 text-slate-500 transition group-hover:text-slate-200" />
        </div>
      </button>
    </article>
  );
}

function HomeDashboard({
  feedback,
  error,
  filteredProjects,
  homeQuery,
  onDeleteProject,
  onLogout,
  onOpenProject,
  onProjectUpload,
  onSearchChange,
  onUploadClick,
  projectNameCounts,
  totalProjects,
}: {
  feedback: string | null;
  error: string | null;
  filteredProjects: ProjectRecord[];
  homeQuery: string;
  onDeleteProject: (project: ProjectRecord) => void;
  onLogout: () => void;
  onOpenProject: (projectId: string) => void;
  onProjectUpload: () => void;
  onSearchChange: (value: string) => void;
  onUploadClick: () => void;
  projectNameCounts: Map<string, number>;
  totalProjects: number;
}) {
  return (
    <main className="h-screen overflow-hidden bg-[#2b2c30] text-[#f3f4f8]">
      <div className="grid h-full grid-cols-[220px_minmax(0,1fr)]">
        <aside className="flex min-h-0 flex-col border-r border-white/[0.08] bg-[#242528] px-3 pb-4 pt-3">
          <div className="flex items-center justify-between gap-3 px-2">
            <div className="flex min-w-0 items-center gap-3">
              <UserBadgeButton onClick={onLogout} />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-white">amirhor98</p>
                <p className="text-xs text-slate-400">Personal workspace</p>
              </div>
            </div>
            <Bell className="h-4 w-4 shrink-0 text-slate-500" />
          </div>

          <div className="mt-4">
            <label className="relative block">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
              <input
                className="h-10 w-full rounded-[12px] border border-white/[0.06] bg-[#2c2d31] pl-9 pr-3 text-sm text-white outline-none transition placeholder:text-slate-500 focus:border-white/[0.14]"
                placeholder="Search projects"
                value={homeQuery}
                onChange={(event) => onSearchChange(event.target.value)}
              />
            </label>
          </div>

          <nav className="mt-5 space-y-1.5">
            <button className="flex h-10 w-full items-center gap-3 rounded-[12px] bg-[#4b5681] px-3 text-sm font-medium text-white" type="button">
              <Clock3 className="h-4 w-4" />
              Recents
            </button>
            <button className="flex h-10 w-full items-center gap-3 rounded-[12px] px-3 text-sm text-slate-300 transition hover:bg-white/[0.04] hover:text-white" type="button">
              <Grid2x2 className="h-4 w-4" />
              All projects
            </button>
            <button
              className="flex h-10 w-full items-center gap-3 rounded-[12px] px-3 text-sm text-slate-300 transition hover:bg-white/[0.04] hover:text-white"
              type="button"
              onClick={onProjectUpload}
            >
              <FolderOpen className="h-4 w-4" />
              Uploads
            </button>
          </nav>

          <button
            className="mt-6 inline-flex h-10 items-center justify-center gap-2 rounded-[12px] bg-[#5f62ff] px-4 text-sm font-medium text-white transition hover:bg-[#7174ff]"
            type="button"
            onClick={onUploadClick}
          >
            <Plus className="h-4 w-4" />
            Upload project zip
          </button>

          {(feedback || error) ? (
            <div
              className={clsx(
                "mt-4 rounded-[16px] border px-3 py-3 text-sm leading-6",
                error
                  ? "border-rose-300/15 bg-rose-300/10 text-rose-100"
                  : "border-emerald-300/15 bg-emerald-300/10 text-emerald-100",
              )}
            >
              {error || feedback}
            </div>
          ) : null}
        </aside>

        <section className="min-w-0 overflow-y-auto px-7 pb-8 pt-4">
          <div className="flex items-center justify-end gap-3">
            <button
              className="inline-flex h-10 items-center justify-center gap-2 rounded-[12px] border border-white/[0.08] bg-[#2f3034] px-4 text-sm font-medium text-white transition hover:bg-[#34363b]"
              type="button"
              onClick={onUploadClick}
            >
              <Plus className="h-4 w-4" />
              New upload
            </button>
          </div>

          <div className="mt-5 rounded-[24px] border border-white/[0.08] bg-[#313236] p-4">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <p className="text-base font-medium text-white">Recommended resources from Community</p>
                <p className="mt-1 text-sm text-slate-400">A Figma-style home surface for opening and organizing your projects.</p>
              </div>
              <Sparkles className="h-4 w-4 text-slate-400" />
            </div>
            <div className="grid gap-4 xl:grid-cols-4 md:grid-cols-2">
              {HOME_RESOURCE_CARDS.map((card) => (
                <div
                  key={card.title}
                  className="overflow-hidden rounded-[18px] border border-white/[0.08] bg-[#2a2b2f]"
                >
                  <div className="h-[146px] border-b border-white/[0.06]" style={{ background: card.background }} />
                  <div className="p-3">
                    <p className="text-sm font-medium text-white">{card.title}</p>
                    <p className="mt-1 text-xs text-slate-400">{card.subtitle}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="mt-7 flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-lg font-medium text-white">Recently viewed</p>
              <p className="mt-1 text-sm text-slate-400">
                {filteredProjects.length === totalProjects
                  ? `${totalProjects} uploaded project${totalProjects === 1 ? "" : "s"}`
                  : `${filteredProjects.length} of ${totalProjects} projects`}
              </p>
            </div>
            <div className="flex items-center gap-2 text-sm text-slate-400">
              <span className="rounded-full border border-white/[0.08] bg-[#2f3034] px-3 py-1.5">
                All files
              </span>
              <span className="rounded-full border border-white/[0.08] bg-[#2f3034] px-3 py-1.5">
                Last viewed
              </span>
            </div>
          </div>

          {filteredProjects.length ? (
            <div className="mt-4 grid gap-5 xl:grid-cols-3 md:grid-cols-2">
              {filteredProjects.map((project) => (
                <HomeProjectCard
                  key={project.id}
                  project={project}
                  label={projectOptionLabel(project, projectNameCounts)}
                  onDelete={onDeleteProject}
                  onOpen={onOpenProject}
                />
              ))}
            </div>
          ) : (
            <div className="mt-4 rounded-[24px] border border-dashed border-white/[0.08] bg-[#2f3034] px-6 py-12 text-center">
              <p className="text-lg font-medium text-white">No matching projects yet</p>
              <p className="mt-2 text-sm leading-7 text-slate-400">
                Upload a zip to start a new project, or clear the search to see everything you already imported.
              </p>
            </div>
          )}
        </section>
      </div>
    </main>
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
  const [homeQuery, setHomeQuery] = useState("");
  const [isShareMenuOpen, setIsShareMenuOpen] = useState(false);
  const [selectedAttachmentIds, setSelectedAttachmentIds] = useState<string[]>([]);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPreviewFrameReady, setIsPreviewFrameReady] = useState(false);
  const [isPreviewSlow, setIsPreviewSlow] = useState(false);

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const leftRailScrollRef = useRef<HTMLDivElement>(null);
  const projectUploadInputRef = useRef<HTMLInputElement>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const shareMenuRef = useRef<HTMLDivElement>(null);
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
  const filteredProjects = useMemo(() => {
    const query = homeQuery.trim().toLowerCase();
    if (!query) {
      return snapshot.projects;
    }

    return snapshot.projects.filter((project) =>
      projectOptionLabel(project, projectNameCounts).toLowerCase().includes(query),
    );
  }, [homeQuery, projectNameCounts, snapshot.projects]);

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
    setIsShareMenuOpen(false);
  }, [currentProject?.project.id]);

  useEffect(() => {
    const rail = leftRailScrollRef.current;
    if (!rail) {
      return;
    }

    rail.scrollTop = rail.scrollHeight;
  }, [currentProject?.project.id, currentProject?.project.currentRevisionId, orderedRevisions.length]);

  useEffect(() => {
    function handlePointerDown(event: MouseEvent) {
      if (
        shareMenuRef.current &&
        event.target instanceof Node &&
        !shareMenuRef.current.contains(event.target)
      ) {
        setIsShareMenuOpen(false);
      }
    }

    window.addEventListener("mousedown", handlePointerDown);
    return () => window.removeEventListener("mousedown", handlePointerDown);
  }, []);

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
            ? `Selected ${payload.nearestFramerName || payload.tagName.toLowerCase()} on ${payload.route}.`
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

  function syncBrowserLocation(projectId: string | null) {
    if (typeof window === "undefined") {
      return;
    }

    const nextPath = projectId ? `/?projectId=${encodeURIComponent(projectId)}` : "/";
    if (`${window.location.pathname}${window.location.search}` !== nextPath) {
      window.history.replaceState({}, "", nextPath);
    }
  }

  function applySnapshot(nextSnapshot: SnapshotResponse) {
    setSnapshot(nextSnapshot);
    syncBrowserLocation(nextSnapshot.currentProjectId);
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

  async function handleDeleteProject(project?: ProjectRecord) {
    const targetProject = project || currentProject?.project;
    if (!targetProject) {
      return;
    }

    try {
      setError(null);
      setFeedback(`Removing ${targetProject.name}...`);
      const response = await fetch(`/api/projects/${targetProject.id}`, {
        method: "DELETE",
      });
      const data = await readJsonResponse<SnapshotResponse>(response);
      applySnapshot(data);
      setPrompt("");
      setIsPicking(false);
      setIsCodePanelOpen(false);
      setSelectedElement(null);
      setSelectedAttachmentIds([]);
      setFeedback(`Removed ${targetProject.name}.`);
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

  function goHome() {
    setSnapshot((previous) => ({
      ...previous,
      currentProjectId: null,
      currentProject: null,
    }));
    setPrompt("");
    setSelectedElement(null);
    setSelectedAttachmentIds([]);
    setIsPicking(false);
    setIsCodePanelOpen(false);
    setIsShareMenuOpen(false);
    setFeedback(null);
    setError(null);
    syncBrowserLocation(null);
  }

  async function handleCopyPublishedLink() {
    if (!currentProject) {
      return;
    }

    const shareUrl = new URL(
      `/published/${currentProject.project.id}`,
      window.location.origin,
    ).toString();
    setIsShareMenuOpen(false);

    try {
      await navigator.clipboard.writeText(shareUrl);
      setFeedback("Copied the published full-screen link and opened it in a new tab.");
    } catch {
      setFeedback("Opened the published full-screen link in a new tab.");
    }

    window.open(shareUrl, "_blank", "noopener,noreferrer");
  }

  function handleExportProject() {
    if (!currentProject) {
      return;
    }

    setIsShareMenuOpen(false);
    window.open(`/api/projects/${currentProject.project.id}/export`, "_blank", "noopener,noreferrer");
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
  const sharedInputs = (
    <>
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
    </>
  );

  if (!currentProject) {
    return (
      <>
        <HomeDashboard
          feedback={feedback}
          error={error}
          filteredProjects={filteredProjects}
          homeQuery={homeQuery}
          onDeleteProject={(project) => void handleDeleteProject(project)}
          onLogout={() => void handleLogout()}
          onOpenProject={(projectId) => void handleProjectChange(projectId)}
          onProjectUpload={() => projectUploadInputRef.current?.click()}
          onSearchChange={setHomeQuery}
          onUploadClick={() => projectUploadInputRef.current?.click()}
          projectNameCounts={projectNameCounts}
          totalProjects={snapshot.projects.length}
        />
        {sharedInputs}
      </>
    );
  }

  return (
    <main className="h-screen overflow-hidden bg-[#1f2023] text-[#f2f2f4]">
      <div className="flex h-full flex-col">
        <header className="grid h-[60px] shrink-0 grid-cols-[336px_minmax(0,1fr)] border-b border-white/[0.08] bg-[#242528]">
          <div className="flex min-w-0 items-center gap-2 border-r border-white/[0.08] px-3">
            <ToolbarIconButton label="Go to home" onClick={goHome}>
              <House className="h-4 w-4" />
            </ToolbarIconButton>
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

            <span className="text-sm font-medium text-slate-300">
              {currentCheckpointLabel}
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
              <ToolbarIconButton
                label={isCodePanelOpen ? "Close code panel" : "Open code panel"}
                active={isCodePanelOpen}
                onClick={() => setIsCodePanelOpen((value) => !value)}
              >
                <Code2 className="h-4 w-4" />
              </ToolbarIconButton>
              <div ref={shareMenuRef} className="relative">
                <button
                  className="inline-flex h-9 items-center gap-2 rounded-[12px] bg-[#5f62ff] px-4 text-sm font-medium text-white transition hover:bg-[#6d70ff]"
                  type="button"
                  onClick={() => setIsShareMenuOpen((value) => !value)}
                >
                  Share
                  <ChevronDown className="h-4 w-4" />
                </button>

                {isShareMenuOpen ? (
                  <div className="absolute right-0 top-[calc(100%+10px)] z-50 w-[260px] rounded-[18px] border border-white/[0.08] bg-[#2a2b2f] p-2 shadow-[0_28px_64px_rgba(0,0,0,0.38)]">
                    <button
                      className="flex w-full items-start gap-3 rounded-[14px] px-3 py-3 text-left transition hover:bg-white/[0.04]"
                      type="button"
                      onClick={() => void handleCopyPublishedLink()}
                    >
                      <ExternalLink className="mt-0.5 h-4 w-4 shrink-0 text-slate-300" />
                      <div>
                        <p className="text-sm font-medium text-white">Publish</p>
                        <p className="mt-1 text-xs leading-5 text-slate-400">
                          Open and copy a full-screen link to share this UI with other people.
                        </p>
                      </div>
                    </button>
                    <button
                      className="flex w-full items-start gap-3 rounded-[14px] px-3 py-3 text-left transition hover:bg-white/[0.04]"
                      type="button"
                      onClick={handleExportProject}
                    >
                      <Download className="mt-0.5 h-4 w-4 shrink-0 text-slate-300" />
                      <div>
                        <p className="text-sm font-medium text-white">Export</p>
                        <p className="mt-1 text-xs leading-5 text-slate-400">
                          Download the current checkpoint as a project zip.
                        </p>
                      </div>
                    </button>
                  </div>
                ) : null}
              </div>
              <UserBadgeButton onClick={() => void handleLogout()} />
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
                    {selectedElementTitle(selectedElement)}
                  </p>
                  <p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-400">
                    {selectedElementSummary(selectedElement)}
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

      {sharedInputs}
    </main>
  );
}
