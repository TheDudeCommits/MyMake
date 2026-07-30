"use client";

import MonacoEditor from "@monaco-editor/react";
import { usePrivy } from "@privy-io/react-auth";
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
  Settings2,
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
  ConversationTurnRecord,
  DashboardSnapshot,
  DevicePreset,
  FileNode,
  GitHubConnectionRecord,
  GitHubRepoSummary,
  MakeKitRecord,
  ProjectRecord,
  ProjectWorkspace,
  RevisionRecord,
  SelectionPayload,
  SelectionResolutionResponse,
  SelectionScopeMode,
  SelectionTarget,
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
const CODEX_BRIDGE_ORIGIN = "http://127.0.0.1:8766";
const CODEX_BRIDGE_BOOT_COMMAND = "npm --prefix /Users/amir/Downloads/MyMake run codex-bridge";
const EMPTY_REVISIONS: RevisionRecord[] = [];
const EMPTY_ATTACHMENTS: AttachmentRecord[] = [];
const EMPTY_TURNS: ConversationTurnRecord[] = [];
const EMPTY_KITS: MakeKitRecord[] = [];
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
  feedback?: string | null;
};

type CodexBridgeEditResponse = {
  ok: true;
  projectId: string;
  threadId: string;
  summary: string;
  changedFiles: Array<{ path: string; reason?: string }>;
};

type CodexBridgeMode = "always-on" | "codex-app";

type CodexBridgeProjectStateRecord = {
  projectId: string;
  userId: string | null;
  projectName: string;
  threadId: string | null;
  lastSyncedRevisionId: string | null;
  updatedAt: string;
};

type CodexBridgeHealth = {
  ok: true;
  codexBin: string;
  bridgeRoot: string;
  config: {
    mode: CodexBridgeMode;
    autoStart: boolean;
    updatedAt: string;
  };
  launchAgentInstalled: boolean;
  launchAgentLoaded: boolean;
  launchAgentPath: string;
  codexAppRunning: boolean;
};

type CodexBridgeProjectStateResponse = {
  projectId: string;
  userId: string | null;
  state: CodexBridgeProjectStateRecord | null;
  codexAppRunning: boolean;
};

type CodexOpenSessionResponse = {
  ok: true;
  projectId: string;
  threadId: string | null;
  resumed: boolean;
  command: string;
};

class RequestError extends Error {
  details: string[];
  rawProviderOutput: string | null;

  constructor(
    message: string,
    options?: { details?: string[]; rawProviderOutput?: string | null },
  ) {
    super(message);
    this.name = "RequestError";
    this.details = options?.details || [];
    this.rawProviderOutput = options?.rawProviderOutput || null;
  }
}

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

  if (model.key === "openai-codex") {
    return "Codex";
  }

  if (model.key === "anthropic-sonnet-4-6") {
    return "Sonnet 4.6";
  }

  return model.label;
}

function checkpointLabel(revision: RevisionRecord): string {
  return `#${String(revision.sequence + 1).padStart(2, "0")}`;
}

function codexModeLabel(mode: CodexBridgeMode): string {
  return mode === "codex-app" ? "Only when Codex.app is open" : "Always available";
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
    selection.contextTexts?.join(" / ") ||
    selection.textContent ||
    selection.nearestFramerName ||
    selection.scopedSelector ||
    selection.selector ||
    selection.domPath
  );
}

function selectionSupportsAllMatching(selection: SelectionPayload | null): boolean {
  if (!selection) {
    return false;
  }

  return Boolean(
    selection.allInstanceSelector ||
      selection.instanceIndex ||
      selection.instanceScope?.includes(":nth-of-type(") ||
      selection.scopeSelector?.includes(":nth-of-type("),
  );
}

function buildScopedSelectionPayload(
  selection: SelectionPayload | null,
  scopeMode: SelectionScopeMode,
): SelectionPayload | null {
  if (!selection) {
    return null;
  }

  return {
    ...selection,
    targetScope: scopeMode,
  };
}

function selectionScopeLabel(scopeMode: SelectionScopeMode): string {
  return scopeMode === "all-matching" ? "All matching" : "This instance";
}

function normalizeColorForInput(value: string | null | undefined): string {
  if (!value) {
    return "#ffffff";
  }

  const normalized = value.trim();
  if (/^#[0-9a-f]{3}$/i.test(normalized)) {
    return `#${normalized[1]}${normalized[1]}${normalized[2]}${normalized[2]}${normalized[3]}${normalized[3]}`.toLowerCase();
  }
  if (/^#[0-9a-f]{6}$/i.test(normalized)) {
    return normalized.toLowerCase();
  }
  return "#ffffff";
}

function normalizeInspectorValue(value: string | number | null | undefined): string {
  if (value === null || value === undefined) {
    return "";
  }

  return String(value).trim();
}

function resolvedHandleValue(target: SelectionTarget | null, key: string): string | null {
  return (
    target?.proofHandles.find((handle) => handle.key === key)?.value ||
    target?.resolvedHandles.find((handle) => handle.key === key)?.currentValue ||
    null
  );
}

function selectionResolutionLabel(
  method: SelectionTarget["resolutionMethod"] | null | undefined,
): string {
  switch (method) {
    case "react-source-anchor":
      return "React source anchor";
    case "react-source-hints":
      return "React source hints";
    case "heuristic-file-score":
      return "Heuristic match";
    case "active-file-fallback":
      return "Active file fallback";
    case "route-fallback":
      return "Route fallback";
    default:
      return "Pending";
  }
}

function inferPlannedLane(selection: SelectionPayload | null, prompt: string): string {
  const normalized = prompt.toLowerCase();
  if (
    selection &&
    (/change|replace|rename|remove|delete|hide/.test(normalized) ||
      /line|stroke|fill|background|radius|spacing/.test(normalized))
  ) {
    return "Deterministic";
  }
  if (selection) {
    return "Scoped AI";
  }
  return "Deep Fix";
}

function turnStatusLabel(turn: ConversationTurnRecord): string {
  if (turn.status === "failed") {
    return "Failed";
  }

  if (turn.warnings.length) {
    return "Warning";
  }

  if (turn.status === "applied") {
    return "Applied";
  }

  return "Info";
}

function turnStatusClasses(turn: ConversationTurnRecord): string {
  if (turn.status === "failed") {
    return "border-rose-300/20 bg-rose-300/10 text-rose-100";
  }

  if (turn.warnings.length) {
    return "border-amber-300/20 bg-amber-300/10 text-amber-100";
  }

  if (turn.status === "applied") {
    return "border-emerald-300/20 bg-emerald-300/10 text-emerald-100";
  }

  return "border-white/[0.08] bg-[#262628] text-slate-300";
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

function GitHubMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path d="M12 2C6.477 2 2 6.596 2 12.266c0 4.535 2.865 8.382 6.839 9.74.5.095.683-.222.683-.493 0-.243-.009-.887-.014-1.741-2.782.62-3.369-1.382-3.369-1.382-.455-1.185-1.11-1.501-1.11-1.501-.908-.64.069-.627.069-.627 1.004.072 1.531 1.058 1.531 1.058.892 1.569 2.341 1.116 2.91.853.091-.664.349-1.116.635-1.373-2.221-.26-4.555-1.138-4.555-5.066 0-1.119.389-2.034 1.026-2.751-.103-.261-.445-1.311.098-2.733 0 0 .837-.275 2.744 1.051A9.354 9.354 0 0 1 12 7.84c.851.004 1.708.117 2.507.344 1.905-1.326 2.74-1.051 2.74-1.051.546 1.422.204 2.472.101 2.733.639.717 1.025 1.632 1.025 2.751 0 3.938-2.338 4.803-4.566 5.058.359.319.679.949.679 1.913 0 1.381-.012 2.494-.012 2.833 0 .274.18.593.688.492C19.138 20.644 22 16.799 22 12.266 22 6.596 17.523 2 12 2Z" />
    </svg>
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

function UserBadgeButton({
  onClick,
  label,
}: {
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      className="group relative grid h-8 w-8 place-items-center rounded-full bg-[#6675a0] text-white transition hover:bg-[#7787b6]"
      type="button"
      title="Sign out"
      aria-label="Sign out"
      onClick={onClick}
    >
      <span className="text-[12px] font-semibold uppercase transition group-hover:opacity-0">
        {label.slice(0, 1)}
      </span>
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
  codexBridgeReachable,
  feedback,
  error,
  filteredProjects,
  githubConnection,
  homeQuery,
  onOpenCodexSettings,
  onImportRepo,
  onDeleteProject,
  onLogout,
  onOpenProject,
  onProjectUpload,
  onSearchChange,
  onUploadClick,
  projectNameCounts,
  totalProjects,
  viewer,
}: {
  codexBridgeReachable: boolean;
  feedback: string | null;
  error: string | null;
  filteredProjects: ProjectRecord[];
  githubConnection: GitHubConnectionRecord;
  homeQuery: string;
  onOpenCodexSettings: () => void;
  onImportRepo: () => void;
  onDeleteProject: (project: ProjectRecord) => void;
  onLogout: () => void;
  onOpenProject: (projectId: string) => void;
  onProjectUpload: () => void;
  onSearchChange: (value: string) => void;
  onUploadClick: () => void;
  projectNameCounts: Map<string, number>;
  totalProjects: number;
  viewer: DashboardSnapshot["viewer"];
}) {
  const viewerLabel = viewer?.displayName || viewer?.email || "A";
  const workspaceTitle = viewer?.email || "Personal workspace";

  return (
    <main className="h-screen overflow-hidden bg-[#2b2c30] text-[#f3f4f8]">
      <div className="grid h-full grid-cols-[220px_minmax(0,1fr)]">
        <aside className="flex min-h-0 flex-col border-r border-white/[0.08] bg-[#242528] px-3 pb-4 pt-3">
          <div className="flex items-center justify-between gap-3 px-2">
            <div className="flex min-w-0 items-center gap-3">
              <UserBadgeButton onClick={onLogout} label={viewerLabel} />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-white">{viewerLabel}</p>
                <p className="truncate text-xs text-slate-400">{workspaceTitle}</p>
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
              title={
                codexBridgeReachable
                  ? "Adjust local Codex bridge settings"
                  : "Open Codex bridge settings"
              }
              onClick={onOpenCodexSettings}
            >
              <Settings2 className="h-4 w-4" />
              Codex settings
            </button>
            <button
              className="inline-flex h-10 items-center justify-center gap-2 rounded-[12px] border border-white/[0.08] bg-[#2f3034] px-4 text-sm font-medium text-white transition hover:bg-[#34363b]"
              type="button"
              onClick={onImportRepo}
            >
              <GitHubMark className="h-4 w-4" />
              {githubConnection.connected ? "Import GitHub repo" : "Connect GitHub"}
            </button>
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

function GitHubModal({
  connection,
  currentProject,
  isLoading,
  isSubmitting,
  mode,
  newRepoName,
  newRepoPrivate,
  onClose,
  onConnectGitHub,
  onCreateRepo,
  onImportRepo,
  onNewRepoNameChange,
  onNewRepoPrivateChange,
  onRepoConnect,
  onSetMode,
  repos,
}: {
  connection: GitHubConnectionRecord;
  currentProject: ProjectWorkspace | null;
  isLoading: boolean;
  isSubmitting: boolean;
  mode: "import" | "connect";
  newRepoName: string;
  newRepoPrivate: boolean;
  onClose: () => void;
  onConnectGitHub: () => void;
  onCreateRepo: () => void;
  onImportRepo: (repo: GitHubRepoSummary) => void;
  onNewRepoNameChange: (value: string) => void;
  onNewRepoPrivateChange: (value: boolean) => void;
  onRepoConnect: (repo: GitHubRepoSummary) => void;
  onSetMode: (mode: "import" | "connect") => void;
  repos: GitHubRepoSummary[];
}) {
  const isProjectMode = mode === "connect";

  return (
    <div className="fixed inset-0 z-[90] grid place-items-center bg-black/55 px-4 py-8 backdrop-blur-sm">
      <div className="w-full max-w-[760px] rounded-[28px] border border-white/[0.08] bg-[#242528] p-5 shadow-[0_30px_90px_rgba(0,0,0,0.42)]">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-lg font-medium text-white">
              {isProjectMode ? "Connect this project to GitHub" : "Import a GitHub repo"}
            </p>
            <p className="mt-1 text-sm leading-6 text-slate-400">
              {isProjectMode
                ? "Link this project to an existing repo, or create a brand new repo and push from MyMake."
                : "Choose a repo to clone into MyMake as a new live-edit project."}
            </p>
          </div>
          <button
            className="grid h-8 w-8 place-items-center rounded-full text-slate-400 transition hover:bg-white/[0.04] hover:text-white"
            type="button"
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        <div className="mt-4 flex items-center gap-2">
          <button
            className={clsx(
              "rounded-full px-3 py-1.5 text-sm transition",
              mode === "import"
                ? "bg-[#5f62ff] text-white"
                : "bg-[#2f3034] text-slate-300 hover:text-white",
            )}
            type="button"
            onClick={() => onSetMode("import")}
          >
            Import repo
          </button>
          {currentProject ? (
            <button
              className={clsx(
                "rounded-full px-3 py-1.5 text-sm transition",
                mode === "connect"
                  ? "bg-[#5f62ff] text-white"
                  : "bg-[#2f3034] text-slate-300 hover:text-white",
              )}
              type="button"
              onClick={() => onSetMode("connect")}
            >
              Connect current project
            </button>
          ) : null}
        </div>

        {!connection.configured ? (
          <div className="mt-5 rounded-[18px] border border-amber-300/18 bg-amber-300/10 px-4 py-4 text-sm leading-7 text-amber-100">
            Add `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` on Railway first, then reconnect here.
          </div>
        ) : !connection.connected ? (
          <div className="mt-5 rounded-[18px] border border-white/[0.08] bg-[#2c2d31] px-4 py-5">
            <p className="text-sm leading-7 text-slate-300">
              Connect GitHub once, then MyMake can list your repos, import them as projects, and push back to linked repos.
            </p>
            <button
              className="mt-4 inline-flex h-10 items-center gap-2 rounded-[12px] bg-[#5f62ff] px-4 text-sm font-medium text-white transition hover:bg-[#6b6eff]"
              type="button"
              onClick={onConnectGitHub}
            >
              <GitHubMark className="h-4 w-4" />
              Connect GitHub
            </button>
          </div>
        ) : (
          <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1fr)_280px]">
            <div className="min-w-0 rounded-[20px] border border-white/[0.08] bg-[#2c2d31] p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-white">Available repos</p>
                  <p className="mt-1 text-xs text-slate-400">
                    {connection.login ? `Connected as ${connection.login}` : "Connected"}
                  </p>
                </div>
                {isLoading ? <Loader2 className="h-4 w-4 animate-spin text-slate-400" /> : null}
              </div>

              <div className="mt-3 max-h-[360px] space-y-2 overflow-y-auto pr-1">
                {repos.map((repo) => (
                  <button
                    key={repo.id}
                    className="flex w-full items-center justify-between gap-4 rounded-[16px] border border-white/[0.08] bg-[#26272b] px-3 py-3 text-left transition hover:border-white/[0.16] hover:bg-[#2c2d31]"
                    type="button"
                    disabled={isSubmitting}
                    onClick={() =>
                      isProjectMode ? onRepoConnect(repo) : onImportRepo(repo)
                    }
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-white">{repo.fullName}</p>
                      <p className="mt-1 text-xs text-slate-400">
                        {repo.private ? "Private" : "Public"} · {repo.defaultBranch}
                      </p>
                    </div>
                    <ExternalLink className="h-4 w-4 shrink-0 text-slate-500" />
                  </button>
                ))}

                {!repos.length && !isLoading ? (
                  <div className="rounded-[16px] border border-dashed border-white/[0.08] bg-[#26272b] px-4 py-6 text-sm leading-7 text-slate-400">
                    No repos available yet.
                  </div>
                ) : null}
              </div>
            </div>

            {isProjectMode ? (
              <div className="rounded-[20px] border border-white/[0.08] bg-[#2c2d31] p-4">
                <p className="text-sm font-medium text-white">Create a new repo</p>
                <p className="mt-1 text-xs leading-5 text-slate-400">
                  Create a fresh GitHub repo, link this project, then push from the GitHub button in the header.
                </p>
                <label className="mt-4 block">
                  <span className="mb-2 block text-xs uppercase tracking-[0.16em] text-slate-500">
                    Repo name
                  </span>
                  <input
                    className="h-10 w-full rounded-[12px] border border-white/[0.08] bg-[#26272b] px-3 text-sm text-white outline-none transition focus:border-white/[0.16]"
                    value={newRepoName}
                    onChange={(event) => onNewRepoNameChange(event.target.value)}
                    placeholder="mymake-project"
                  />
                </label>
                <label className="mt-3 flex items-center gap-2 text-sm text-slate-300">
                  <input
                    checked={newRepoPrivate}
                    onChange={(event) => onNewRepoPrivateChange(event.target.checked)}
                    type="checkbox"
                  />
                  Private repo
                </label>
                <button
                  className="mt-4 inline-flex h-10 items-center gap-2 rounded-[12px] bg-[#5f62ff] px-4 text-sm font-medium text-white transition hover:bg-[#6b6eff] disabled:cursor-not-allowed disabled:opacity-50"
                  type="button"
                  disabled={isSubmitting || !newRepoName.trim()}
                  onClick={onCreateRepo}
                >
                  {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <GitHubMark className="h-4 w-4" />}
                  Create repo
                </button>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

function CodexSettingsModal({
  bridgeHealth,
  draftAutoStart,
  draftMode,
  isReachable,
  isSaving,
  onAutoStartChange,
  onClose,
  onModeChange,
  onSave,
}: {
  bridgeHealth: CodexBridgeHealth | null;
  draftAutoStart: boolean;
  draftMode: CodexBridgeMode;
  isReachable: boolean;
  isSaving: boolean;
  onAutoStartChange: (value: boolean) => void;
  onClose: () => void;
  onModeChange: (value: CodexBridgeMode) => void;
  onSave: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[95] grid place-items-center bg-black/55 px-4 py-8 backdrop-blur-sm">
      <div className="w-full max-w-[640px] rounded-[28px] border border-white/[0.08] bg-[#242528] p-5 shadow-[0_30px_90px_rgba(0,0,0,0.42)]">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-lg font-medium text-white">Codex bridge settings</p>
            <p className="mt-1 text-sm leading-6 text-slate-400">
              Control how MyMake keeps the local Codex bridge available on this Mac.
            </p>
          </div>
          <button
            className="grid h-8 w-8 place-items-center rounded-full text-slate-400 transition hover:bg-white/[0.04] hover:text-white"
            type="button"
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        {isReachable && bridgeHealth ? (
          <>
            <div className="mt-5 grid gap-3 md:grid-cols-3">
              <div className="rounded-[18px] border border-white/[0.08] bg-[#2c2d31] px-4 py-3">
                <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Bridge</p>
                <p className="mt-2 text-sm font-medium text-white">Reachable</p>
                <p className="mt-1 text-xs leading-5 text-slate-400">
                  Local endpoint is responding on <span className="text-slate-300">127.0.0.1:8766</span>.
                </p>
              </div>
              <div className="rounded-[18px] border border-white/[0.08] bg-[#2c2d31] px-4 py-3">
                <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Launch at login</p>
                <p className="mt-2 text-sm font-medium text-white">
                  {bridgeHealth.launchAgentInstalled ? "Installed" : "Manual only"}
                </p>
                <p className="mt-1 text-xs leading-5 text-slate-400">
                  {bridgeHealth.launchAgentInstalled
                    ? bridgeHealth.launchAgentLoaded
                      ? "launchd will keep the local bridge ready in the background."
                      : "The launch agent exists but is not loaded right now."
                    : "MyMake will only reach Codex when you start the bridge manually."}
                </p>
              </div>
              <div className="rounded-[18px] border border-white/[0.08] bg-[#2c2d31] px-4 py-3">
                <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Codex.app</p>
                <p className="mt-2 text-sm font-medium text-white">
                  {bridgeHealth.codexAppRunning ? "Open" : "Closed"}
                </p>
                <p className="mt-1 text-xs leading-5 text-slate-400">
                  {bridgeHealth.config.mode === "codex-app"
                    ? "This mode keeps Codex tied to the desktop app state."
                    : "Always-on mode can keep Codex edits available even when the desktop app is closed."}
                </p>
              </div>
            </div>

            <div className="mt-5 rounded-[20px] border border-white/[0.08] bg-[#2c2d31] p-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-medium text-white">Start automatically at login</p>
                  <p className="mt-1 text-xs leading-5 text-slate-400">
                    Install a lightweight macOS launchd agent so the bridge is already there when MyMake needs it.
                  </p>
                </div>
                <button
                  className={clsx(
                    "relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition",
                    draftAutoStart ? "bg-[#5f62ff]" : "bg-white/[0.12]",
                  )}
                  type="button"
                  onClick={() => onAutoStartChange(!draftAutoStart)}
                >
                  <span
                    className={clsx(
                      "ml-1 block h-5 w-5 rounded-full bg-white transition",
                      draftAutoStart && "translate-x-5",
                    )}
                  />
                </button>
              </div>

              <div className="mt-5">
                <p className="text-sm font-medium text-white">Local Codex session behavior</p>
                <p className="mt-1 text-xs leading-5 text-slate-400">
                  Choose whether MyMake keeps Codex ready all the time or only when the Codex desktop app is open.
                </p>
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  {([
                    {
                      value: "always-on",
                      title: "Always available",
                      description:
                        "Recommended. MyMake can hand work to the local Codex session immediately.",
                    },
                    {
                      value: "codex-app",
                      title: "Only when Codex.app is open",
                      description:
                        "More explicit. MyMake will require and open Codex.app before local Codex work starts.",
                    },
                  ] as const).map((option) => (
                    <button
                      key={option.value}
                      className={clsx(
                        "rounded-[16px] border px-4 py-4 text-left transition",
                        draftMode === option.value
                          ? "border-[#5f62ff]/45 bg-[#5f62ff]/10 text-white"
                          : "border-white/[0.08] bg-[#26272b] text-slate-300 hover:border-white/[0.14] hover:bg-[#2b2c31]",
                      )}
                      type="button"
                      onClick={() => onModeChange(option.value)}
                    >
                      <p className="text-sm font-medium">{option.title}</p>
                      <p className="mt-2 text-xs leading-5 text-slate-400">{option.description}</p>
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="mt-5 flex items-center justify-between gap-3 rounded-[18px] border border-white/[0.08] bg-[#2c2d31] px-4 py-3 text-xs leading-5 text-slate-400">
              <div>
                <p>
                  Current mode: <span className="text-slate-200">{codexModeLabel(bridgeHealth.config.mode)}</span>
                </p>
                <p className="mt-1">
                  Launch agent path: <span className="text-slate-300">{bridgeHealth.launchAgentPath}</span>
                </p>
              </div>
              <button
                className="inline-flex h-10 items-center gap-2 rounded-[12px] bg-[#5f62ff] px-4 text-sm font-medium text-white transition hover:bg-[#6b6eff] disabled:cursor-not-allowed disabled:opacity-50"
                type="button"
                disabled={isSaving}
                onClick={onSave}
              >
                {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Settings2 className="h-4 w-4" />}
                Save settings
              </button>
            </div>
          </>
        ) : (
          <div className="mt-5 rounded-[20px] border border-amber-300/18 bg-amber-300/10 px-4 py-4 text-sm leading-7 text-amber-100">
            MyMake could not reach the local Codex bridge yet. Start it once with{" "}
            <span className="font-semibold text-white">{CODEX_BRIDGE_BOOT_COMMAND}</span>, then
            reopen this panel to enable login-at-startup and session mode controls.
          </div>
        )}
      </div>
    </div>
  );
}

export function WorkspaceApp({ initialSnapshot }: { initialSnapshot: DashboardSnapshot }) {
  const { logout } = usePrivy();
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [devicePreset, setDevicePreset] = useState<DevicePreset>("desktop");
  const [isPicking, setIsPicking] = useState(false);
  const [isCodePanelOpen, setIsCodePanelOpen] = useState(false);
  const [selectedAiModelKey, setSelectedAiModelKey] = useState<AiModelKey>(
    initialSnapshot.defaultAiModelKey,
  );
  const [selectedElement, setSelectedElement] = useState<SelectionPayload | null>(null);
  const [selectionScopeMode, setSelectionScopeMode] = useState<SelectionScopeMode>("instance");
  const [resolvedSelectionTarget, setResolvedSelectionTarget] = useState<SelectionTarget | null>(null);
  const [isResolvingSelection, setIsResolvingSelection] = useState(false);
  const [inspectorTextValue, setInspectorTextValue] = useState("");
  const [inspectorLineColor, setInspectorLineColor] = useState("#ffffff");
  const [inspectorFillColor, setInspectorFillColor] = useState("#ffffff");
  const [inspectorSpacingXValue, setInspectorSpacingXValue] = useState("");
  const [inspectorSpacingYValue, setInspectorSpacingYValue] = useState("");
  const [inspectorRadiusValue, setInspectorRadiusValue] = useState("");
  const [inspectorFontSizeValue, setInspectorFontSizeValue] = useState("");
  const [inspectorImageValue, setInspectorImageValue] = useState("");
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
  const [isGitHubModalOpen, setIsGitHubModalOpen] = useState(false);
  const [isCodexSettingsOpen, setIsCodexSettingsOpen] = useState(false);
  const [gitHubModalMode, setGitHubModalMode] = useState<"import" | "connect">("import");
  const [gitHubRepos, setGitHubRepos] = useState<GitHubRepoSummary[]>([]);
  const [isGitHubReposLoading, setIsGitHubReposLoading] = useState(false);
  const [isGitHubSubmitting, setIsGitHubSubmitting] = useState(false);
  const [isCodexSettingsSaving, setIsCodexSettingsSaving] = useState(false);
  const [newGitHubRepoName, setNewGitHubRepoName] = useState("");
  const [newGitHubRepoPrivate, setNewGitHubRepoPrivate] = useState(true);
  const [selectedAttachmentIds, setSelectedAttachmentIds] = useState<string[]>([]);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [composerErrorDetails, setComposerErrorDetails] = useState<string[]>([]);
  const [composerErrorRawOutput, setComposerErrorRawOutput] = useState<string | null>(null);
  const [isComposerNoticeExpanded, setIsComposerNoticeExpanded] = useState(false);
  const [expandedTurnIds, setExpandedTurnIds] = useState<string[]>([]);
  const [isPreviewFrameReady, setIsPreviewFrameReady] = useState(false);
  const [isPreviewSlow, setIsPreviewSlow] = useState(false);
  const [previewNonce, setPreviewNonce] = useState(0);
  const [codexBridgeHealth, setCodexBridgeHealth] = useState<CodexBridgeHealth | null>(null);
  const [codexBridgeProjectState, setCodexBridgeProjectState] =
    useState<CodexBridgeProjectStateRecord | null>(null);
  const [codexBridgeDraftMode, setCodexBridgeDraftMode] =
    useState<CodexBridgeMode>("always-on");
  const [codexBridgeDraftAutoStart, setCodexBridgeDraftAutoStart] = useState(false);

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const leftRailScrollRef = useRef<HTMLDivElement>(null);
  const projectUploadInputRef = useRef<HTMLInputElement>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const shareMenuRef = useRef<HTMLDivElement>(null);
  const previousPreviewIdentityRef = useRef<string | null>(null);
  const previousRevisionIdRef = useRef<string | null>(null);
  const didHydrateCodexBridgeSettingsRef = useRef(false);
  const refreshCodexBridgeHealthRef =
    useRef<((options?: { silent?: boolean }) => Promise<CodexBridgeHealth | null>) | undefined>(
      undefined,
    );
  const refreshCodexProjectStateRef =
    useRef<
      | ((projectId: string | null | undefined) => Promise<CodexBridgeProjectStateRecord | null>)
      | undefined
    >(undefined);

  const currentProject = snapshot.currentProject;
  const viewer = snapshot.viewer;
  const githubConnection = snapshot.githubConnection;
  const githubBinding = currentProject?.githubBinding ?? null;
  const revisions = currentProject?.revisions ?? EMPTY_REVISIONS;
  const conversationTurns = currentProject?.conversationTurns ?? EMPTY_TURNS;
  const kits = currentProject?.kits ?? EMPTY_KITS;
  const orderedRevisions = useMemo(
    () => [...revisions].sort((left, right) => left.sequence - right.sequence),
    [revisions],
  );
  const attachments = currentProject?.attachments ?? EMPTY_ATTACHMENTS;
  const currentDevice = DEVICE_PRESETS[devicePreset];
  const isDesktopPreview = devicePreset === "desktop";
  const displayRoute = routeLabel(currentRoute);
  const effectiveSelectedElement = useMemo(
    () => buildScopedSelectionPayload(selectedElement, selectionScopeMode),
    [selectedElement, selectionScopeMode],
  );
  const plannedLaneLabel = useMemo(
    () => inferPlannedLane(effectiveSelectedElement, prompt),
    [effectiveSelectedElement, prompt],
  );
  const inspectorCapabilityKeys = useMemo(
    () =>
      new Set([
        ...(selectedElement?.editableProperties || []),
        ...(resolvedSelectionTarget?.editableCapabilities || []).map((item) => item.key),
      ]),
    [resolvedSelectionTarget, selectedElement],
  );
  const resolvedProofHandles = useMemo(
    () =>
      (resolvedSelectionTarget?.proofHandles || [])
        .filter((handle) => Boolean(handle.value))
        .slice(0, 6),
    [resolvedSelectionTarget],
  );

  useEffect(() => {
    setInspectorTextValue(
      normalizeInspectorValue(resolvedHandleValue(resolvedSelectionTarget, "text")) ||
        selectedElement?.textContent ||
        "",
    );
    setInspectorLineColor(
      normalizeColorForInput(
        resolvedHandleValue(resolvedSelectionTarget, "line-color") ||
          resolvedSelectionTarget?.styleSnapshot?.lineColor ||
          selectedElement?.attributes?.stroke,
      ),
    );
    setInspectorFillColor(
      normalizeColorForInput(
        resolvedHandleValue(resolvedSelectionTarget, "fill-color") ||
          resolvedHandleValue(resolvedSelectionTarget, "background-color") ||
          resolvedSelectionTarget?.styleSnapshot?.fillColor ||
          resolvedSelectionTarget?.styleSnapshot?.backgroundColor ||
          (selectedElement?.attributes?.fill && selectedElement.attributes.fill !== "none"
            ? selectedElement.attributes.fill
            : selectedElement?.attributes?.["background-color"]),
      ),
    );
    setInspectorSpacingXValue(
      normalizeInspectorValue(
        resolvedHandleValue(resolvedSelectionTarget, "spacing-x") ||
          resolvedSelectionTarget?.styleSnapshot?.columnGap ||
          resolvedSelectionTarget?.styleSnapshot?.gap,
      ),
    );
    setInspectorSpacingYValue(
      normalizeInspectorValue(
        resolvedHandleValue(resolvedSelectionTarget, "spacing-y") ||
          resolvedSelectionTarget?.styleSnapshot?.rowGap ||
          resolvedSelectionTarget?.styleSnapshot?.gap,
      ),
    );
    setInspectorRadiusValue(
      normalizeInspectorValue(
        resolvedHandleValue(resolvedSelectionTarget, "radius") ||
          resolvedSelectionTarget?.styleSnapshot?.borderRadius,
      ),
    );
    setInspectorFontSizeValue(
      normalizeInspectorValue(
        resolvedHandleValue(resolvedSelectionTarget, "font-size") ||
          resolvedSelectionTarget?.styleSnapshot?.fontSize,
      ),
    );
    setInspectorImageValue(
      normalizeInspectorValue(
        resolvedHandleValue(resolvedSelectionTarget, "image-src") ||
          resolvedSelectionTarget?.styleSnapshot?.imageSrc ||
          selectedElement?.src,
      ),
    );
  }, [resolvedSelectionTarget, selectedElement]);
  const hasUnsavedEdits = Boolean(editorFilePath && editorContent !== editorBaselineContent);
  const previewIdentity = currentProject
    ? `${currentProject.project.id}:${currentProject.preview.instanceId ?? "cold"}`
    : null;
  const previewFrameSrc = useMemo(() => {
    if (!currentProject) {
      return null;
    }

    const searchParams = new URLSearchParams({
      instance: currentProject.preview.instanceId ?? "cold",
      revision: currentProject.project.currentRevisionId ?? "none",
      refresh: String(previewNonce),
    });

    return `${currentProject.preview.url}/?${searchParams.toString()}`;
  }, [
    currentProject,
    previewNonce,
  ]);
  const previewOrigin = useMemo(() => {
    if (!currentProject) {
      return null;
    }

    try {
      const url = new URL(currentProject.preview.url, window.location.origin);
      return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
    } catch {
      return null;
    }
  }, [currentProject]);
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
  const isCodexBridgeReachable = Boolean(codexBridgeHealth?.ok);
  const currentCodexThreadId = codexBridgeProjectState?.threadId || null;
  const codexModeSummary = codexBridgeHealth
    ? `${codexModeLabel(codexBridgeHealth.config.mode)}${codexBridgeHealth.config.autoStart ? " · starts at login" : ""}`
    : null;
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
  const revisionById = useMemo(
    () => new Map(revisions.map((revision) => [revision.id, revision])),
    [revisions],
  );
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
    void refreshCodexBridgeHealthRef.current?.({ silent: true });
  }, []);

  useEffect(() => {
    if (!isCodexSettingsOpen) {
      return;
    }

    void refreshCodexBridgeHealthRef.current?.({ silent: true });
  }, [isCodexSettingsOpen]);

  useEffect(() => {
    void refreshCodexProjectStateRef.current?.(currentProject?.project.id);
  }, [currentProject?.project.id, viewer?.id]);

  useEffect(() => {
    setEditorFilePath(currentProject?.currentFilePath || null);
    setEditorContent(currentProject?.currentFileContent || "");
    setEditorBaselineContent(currentProject?.currentFileContent || "");
  }, [currentProject?.currentFilePath, currentProject?.currentFileContent]);

  useEffect(() => {
    setSelectedAttachmentIds([]);
    setSelectedElement(null);
    setSelectionScopeMode("instance");
    setResolvedSelectionTarget(null);
    setCurrentRoute("/");
    setExpandedTurnIds([]);
    setPreviewNonce(0);
    clearComposerDiagnostics();
  }, [currentProject?.project.id]);

  useEffect(() => {
    if (!currentProject?.project.id || !effectiveSelectedElement) {
      setResolvedSelectionTarget(null);
      setIsResolvingSelection(false);
      return;
    }

    let cancelled = false;
    const projectId = currentProject.project.id;

    async function resolveSelection() {
      setIsResolvingSelection(true);
      try {
        const response = await fetch(`/api/projects/${projectId}/selection`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            selection: effectiveSelectedElement,
            currentFilePath: editorFilePath,
          }),
        });
        const payload = await readJsonResponse<SelectionResolutionResponse>(response);
        if (!cancelled) {
          setResolvedSelectionTarget(payload.target);
        }
      } catch {
        if (!cancelled) {
          setResolvedSelectionTarget(null);
        }
      } finally {
        if (!cancelled) {
          setIsResolvingSelection(false);
        }
      }
    }

    void resolveSelection();

    return () => {
      cancelled = true;
    };
  }, [currentProject?.project.id, effectiveSelectedElement, editorFilePath]);

  useEffect(() => {
    setIsShareMenuOpen(false);
  }, [currentProject?.project.id]);

  useEffect(() => {
    const repoBaseName =
      currentProject?.project.name
        ?.trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "mymake-project";
    setNewGitHubRepoName(repoBaseName);
  }, [currentProject?.project.id, currentProject?.project.name]);

  useEffect(() => {
    if (!isGitHubModalOpen || !githubConnection.connected) {
      return;
    }

    let cancelled = false;

    async function loadRepos() {
      setIsGitHubReposLoading(true);
      try {
        const response = await fetch("/api/github/repos", { cache: "no-store" });
        const payload = await readJsonResponse<{ repos: GitHubRepoSummary[] }>(response);
        if (!cancelled) {
          setGitHubRepos(payload.repos);
        }
      } catch (caughtError) {
        if (!cancelled) {
          setError(
            caughtError instanceof Error
              ? caughtError.message
              : "Could not load GitHub repos.",
          );
        }
      } finally {
        if (!cancelled) {
          setIsGitHubReposLoading(false);
        }
      }
    }

    void loadRepos();

    return () => {
      cancelled = true;
    };
  }, [githubConnection.connected, isGitHubModalOpen]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const url = new URL(window.location.href);
    const githubState = url.searchParams.get("github");
    if (!githubState) {
      return;
    }

    if (githubState === "connected") {
      setFeedback("GitHub connected. Choose a repo to import or link.");
      setError(null);
      setGitHubModalMode(currentProject ? "connect" : "import");
      setIsGitHubModalOpen(true);
    } else if (githubState === "failed") {
      setError("GitHub connection failed. Please try again.");
    }

    url.searchParams.delete("github");
    window.history.replaceState({}, "", `${url.pathname}${url.search}`);
  }, [currentProject]);

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

  function clearComposerDiagnostics() {
    setComposerErrorDetails([]);
    setComposerErrorRawOutput(null);
    setIsComposerNoticeExpanded(false);
  }

  function recordComposerError(caughtError: unknown, fallbackMessage: string) {
    if (caughtError instanceof RequestError) {
      setError(caughtError.message);
      setComposerErrorDetails(caughtError.details);
      setComposerErrorRawOutput(caughtError.rawProviderOutput);
      setIsComposerNoticeExpanded(Boolean(caughtError.details.length || caughtError.rawProviderOutput));
      return;
    }

    setError(caughtError instanceof Error ? caughtError.message : fallbackMessage);
    setComposerErrorDetails([]);
    setComposerErrorRawOutput(null);
    setIsComposerNoticeExpanded(false);
  }

  function toggleTurnExpansion(turnId: string) {
    setExpandedTurnIds((previous) =>
      previous.includes(turnId)
        ? previous.filter((item) => item !== turnId)
        : [...previous, turnId],
    );
  }

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
    setPreviewNonce((value) => value + 1);
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
    setPreviewNonce((value) => value + 1);
  }, [currentProject?.project.currentRevisionId, currentProject?.project.id, previewIdentity]);

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (
        !previewOrigin ||
        event.origin !== previewOrigin ||
        event.source !== iframeRef.current?.contentWindow
      ) {
        return;
      }

      if (!event.data || event.data.channel !== "MYMAKE_PREVIEW_BRIDGE") {
        return;
      }

      if (event.data.type === "MYMAKE_SELECT") {
        const payload = event.data.payload as SelectionPayload;
        setSelectedElement(payload);
        setSelectionScopeMode(payload?.targetScope || "instance");
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
  }, [previewOrigin]);

  useEffect(() => {
    const frameWindow = iframeRef.current?.contentWindow;
    if (!frameWindow || !currentProject || !previewOrigin) {
      return;
    }

    frameWindow.postMessage(
      {
        channel: "MYMAKE_PREVIEW_BRIDGE",
        type: "MYMAKE_SET_PICKING",
        payload: { enabled: isPicking },
      },
      previewOrigin,
    );
  }, [currentProject, isPicking, previewOrigin]);

  async function readJsonResponse<T>(response: Response): Promise<T> {
    const rawBody = await response.text();
    let payload: (T & {
      error?: string;
      details?: string[];
      rawProviderOutput?: string | null;
    }) | null = null;

    try {
      payload = rawBody ? (JSON.parse(rawBody) as T & {
        error?: string;
        details?: string[];
        rawProviderOutput?: string | null;
      }) : null;
    } catch {
      if (!response.ok) {
        throw new RequestError(
          `Request failed (${response.status}${response.statusText ? ` ${response.statusText}` : ""}).`,
          {
            details: rawBody ? [rawBody.slice(0, 1200)] : [],
            rawProviderOutput: null,
          },
        );
      }

      throw new Error("The server returned an invalid response.");
    }

    if (!response.ok) {
      throw new RequestError(payload?.error || `Request failed (${response.status}).`, {
        details: Array.isArray(payload?.details) ? payload.details : [],
        rawProviderOutput:
          typeof payload?.rawProviderOutput === "string" ? payload.rawProviderOutput : null,
      });
    }

    if (!payload) {
      throw new Error("The server returned an empty response.");
    }

    return payload;
  }

  async function readBridgeJson<T>(response: Response): Promise<T> {
    const payload = (await response.json()) as T & {
      error?: string;
      details?: string[];
    };

    if (!response.ok) {
      throw new RequestError(payload.error || "The local Codex bridge request failed.", {
        details: Array.isArray(payload.details) ? payload.details : [],
      });
    }

    return payload;
  }

  async function refreshCodexBridgeHealth(options?: { silent?: boolean }) {
    try {
      const response = await fetch(`${CODEX_BRIDGE_ORIGIN}/health`, {
        cache: "no-store",
      });
      const payload = await readBridgeJson<CodexBridgeHealth>(response);
      setCodexBridgeHealth(payload);
      if (!didHydrateCodexBridgeSettingsRef.current || isCodexSettingsOpen) {
        setCodexBridgeDraftMode(payload.config.mode);
        setCodexBridgeDraftAutoStart(payload.config.autoStart);
        didHydrateCodexBridgeSettingsRef.current = true;
      }
      return payload;
    } catch (caughtError) {
      setCodexBridgeHealth(null);
      if (!options?.silent) {
        throw caughtError;
      }
      return null;
    }
  }

  async function refreshCodexProjectState(projectId: string | null | undefined) {
    if (!projectId) {
      setCodexBridgeProjectState(null);
      return null;
    }

    try {
      const url = new URL(`${CODEX_BRIDGE_ORIGIN}/v1/projects/${projectId}/state`);
      if (viewer?.id) {
        url.searchParams.set("userId", viewer.id);
      }
      const response = await fetch(url.toString(), {
        cache: "no-store",
      });
      const payload = await readBridgeJson<CodexBridgeProjectStateResponse>(response);
      setCodexBridgeProjectState(payload.state);
      return payload.state;
    } catch {
      setCodexBridgeProjectState(null);
      return null;
    }
  }

  refreshCodexBridgeHealthRef.current = refreshCodexBridgeHealth;
  refreshCodexProjectStateRef.current = refreshCodexProjectState;

  async function ensureCodexBridgeAvailable() {
    try {
      const payload = await refreshCodexBridgeHealth();
      if (!payload?.ok) {
        throw new Error("Bridge health check failed.");
      }
    } catch {
      throw new RequestError(
        `MyMake could not reach the local Codex bridge. Start it on this Mac with \`${CODEX_BRIDGE_BOOT_COMMAND}\`.`,
        {
          details: [
            "Codex local mode runs through a local bridge on http://127.0.0.1:8766.",
            `Open a terminal on this Mac and run: ${CODEX_BRIDGE_BOOT_COMMAND}`,
          ],
        },
      );
    }
  }

  async function syncCodexBridgeWorkspace(projectId: string, revisionId: string) {
    const exportResponse = await fetch(`/api/projects/${projectId}/export`, {
      cache: "no-store",
    });
    if (!exportResponse.ok) {
      throw new RequestError("MyMake could not export the current project snapshot for Codex.");
    }

    const zipBlob = await exportResponse.blob();
    const syncResponse = await fetch(`${CODEX_BRIDGE_ORIGIN}/v1/projects/${projectId}/workspace`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/zip",
        "X-MyMake-Project-Name": currentProject?.project.name || projectId,
        "X-MyMake-Revision-Id": revisionId,
        "X-MyMake-User-Id": viewer?.id || "",
      },
      body: zipBlob,
    });
    await readBridgeJson<{ ok: boolean }>(syncResponse);
    await refreshCodexProjectState(projectId);
  }

  async function runCodexBridgeTurn(projectId: string, previousFailures: string[]) {
    const bridgeResponse = await fetch(`${CODEX_BRIDGE_ORIGIN}/v1/projects/${projectId}/edit`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt,
        projectName: currentProject?.project.name || projectId,
        userId: viewer?.id || null,
        currentRoute,
        selection: effectiveSelectedElement,
        previousFailures,
      }),
    });
    return readBridgeJson<CodexBridgeEditResponse>(bridgeResponse);
  }

  async function exportCodexBridgeWorkspace(projectId: string): Promise<Blob> {
    const url = new URL(`${CODEX_BRIDGE_ORIGIN}/v1/projects/${projectId}/export`);
    if (viewer?.id) {
      url.searchParams.set("userId", viewer.id);
    }

    const response = await fetch(url.toString(), {
      cache: "no-store",
    });
    if (!response.ok) {
      throw new RequestError("The local Codex bridge could not export its updated workspace.");
    }

    return response.blob();
  }

  async function applyCodexBridgeWorkspace(
    projectId: string,
    bridgeResult: CodexBridgeEditResponse,
  ) {
    const zipBlob = await exportCodexBridgeWorkspace(projectId);
    const formData = new FormData();
    formData.append("file", new File([zipBlob], `${projectId}.zip`, { type: "application/zip" }));
    formData.append("prompt", prompt);
    formData.append("summary", bridgeResult.summary);
    formData.append("threadId", bridgeResult.threadId);
    formData.append("selection", JSON.stringify(effectiveSelectedElement));
    formData.append("changedFiles", JSON.stringify(bridgeResult.changedFiles));

    const response = await fetch(`/api/projects/${projectId}/codex/apply`, {
      method: "POST",
      body: formData,
    });
    return readJsonResponse<SnapshotResponse>(response);
  }

  async function handleCodexBridgeEdit() {
    if (!currentProject?.project.currentRevisionId) {
      return;
    }

    const maxAttempts = 3;
    let previousFailures: string[] = [];
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        setFeedback(
          attempt === 1
            ? "Syncing the project into your local Codex workspace..."
            : `Codex is retrying with the latest failure context (${attempt}/${maxAttempts})...`,
        );
        await ensureCodexBridgeAvailable();
        await syncCodexBridgeWorkspace(
          currentProject.project.id,
          currentProject.project.currentRevisionId,
        );

        setFeedback(`Codex is working locally on the project (${attempt}/${maxAttempts})...`);
        const bridgeResult = await runCodexBridgeTurn(
          currentProject.project.id,
          previousFailures,
        );

        if (!bridgeResult.changedFiles.length) {
          throw new RequestError("Codex finished without making any file changes.", {
            details: [
              "MyMake retried automatically because the local Codex workspace stayed unchanged.",
            ],
          });
        }

        setFeedback("Applying Codex changes back into MyMake and validating the preview...");
        const snapshotResponse = await applyCodexBridgeWorkspace(
          currentProject.project.id,
          bridgeResult,
        );
        applySnapshot(snapshotResponse);
        await refreshCodexProjectState(currentProject.project.id);
        setPrompt("");
        return;
      } catch (caughtError) {
        lastError = caughtError;
        const details =
          caughtError instanceof RequestError
            ? [caughtError.message, ...caughtError.details]
            : [caughtError instanceof Error ? caughtError.message : "Codex bridge failed."];
        previousFailures = Array.from(new Set([...previousFailures, ...details].filter(Boolean)));

        if (attempt >= maxAttempts) {
          throw caughtError;
        }
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error("Codex bridge could not land the edit.");
  }

  async function handleSaveCodexBridgeSettings() {
    setIsCodexSettingsSaving(true);
    setError(null);

    try {
      await ensureCodexBridgeAvailable();
      const response = await fetch(`${CODEX_BRIDGE_ORIGIN}/v1/settings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          mode: codexBridgeDraftMode,
          autoStart: codexBridgeDraftAutoStart,
        }),
      });
      const payload = await readBridgeJson<CodexBridgeHealth>(response);
      setCodexBridgeHealth(payload);
      setCodexBridgeDraftMode(payload.config.mode);
      setCodexBridgeDraftAutoStart(payload.config.autoStart);
      setFeedback(
        payload.config.autoStart
          ? `Codex bridge settings saved. ${codexModeLabel(payload.config.mode)} and launch-at-login is enabled.`
          : `Codex bridge settings saved. ${codexModeLabel(payload.config.mode)} and launch-at-login is disabled.`,
      );
      setIsCodexSettingsOpen(false);
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "MyMake could not save the local Codex bridge settings.",
      );
    } finally {
      setIsCodexSettingsSaving(false);
    }
  }

  async function handleOpenCodexSession() {
    if (!currentProject?.project.currentRevisionId) {
      return;
    }

    setError(null);
    clearComposerDiagnostics();

    try {
      setFeedback("Preparing the project workspace for its local Codex session...");
      await ensureCodexBridgeAvailable();
      await syncCodexBridgeWorkspace(
        currentProject.project.id,
        currentProject.project.currentRevisionId,
      );

      const response = await fetch(
        `${CODEX_BRIDGE_ORIGIN}/v1/projects/${currentProject.project.id}/open-session`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            userId: viewer?.id || null,
            projectName: currentProject.project.name,
          }),
        },
      );
      const payload = await readBridgeJson<CodexOpenSessionResponse>(response);
      await refreshCodexBridgeHealth({ silent: true });
      await refreshCodexProjectState(currentProject.project.id);
      setFeedback(
        payload.resumed
          ? "Opened this project's existing Codex session in Terminal."
          : "Opened a new interactive Codex session for this project in Terminal.",
      );
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "MyMake could not open the local Codex session.",
      );
    }
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
    clearComposerDiagnostics();
    void refreshCodexProjectState(nextSnapshot.currentProjectId);
    if (nextSnapshot.feedback) {
      setFeedback(nextSnapshot.feedback);
    } else if (nextSnapshot.ai?.summary) {
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

  function openGitHubModal(mode: "import" | "connect") {
    setGitHubModalMode(mode);
    setIsGitHubModalOpen(true);
    setError(null);
  }

  function startGitHubOAuth(mode: "import" | "connect") {
    if (!githubConnection.configured) {
      setError(
        "GitHub OAuth is not configured yet. Add GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET first.",
      );
      return;
    }

    setGitHubModalMode(mode);
    const redirectPath =
      typeof window === "undefined"
        ? "/"
        : `${window.location.pathname}${window.location.search}`;
    window.location.href = `/api/github/connect?redirect=${encodeURIComponent(redirectPath)}`;
  }

  async function handleProjectUpload(file: File) {
    setIsUploading(true);
    setError(null);
    clearComposerDiagnostics();
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
    clearComposerDiagnostics();
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
      clearComposerDiagnostics();
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
    clearComposerDiagnostics();

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

    if (selectedAiModel?.key === "openai-codex" && plannedLaneLabel !== "Deterministic") {
      setIsRunningAi(true);
      setError(null);
      clearComposerDiagnostics();

      try {
        await handleCodexBridgeEdit();
      } catch (caughtError) {
        recordComposerError(caughtError, "Codex could not land the edit.");
      } finally {
        setIsRunningAi(false);
      }
      return;
    }

    if (!selectedAiModel?.enabled) {
      recordComposerError(new Error("The selected AI model is not configured yet."), "The selected AI model is not configured yet.");
      return;
    }

    setIsRunningAi(true);
    setError(null);
    clearComposerDiagnostics();
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
          selection: effectiveSelectedElement,
          attachmentIds: selectedAttachmentIds,
          aiModelKey: selectedAiModel.key,
          currentFilePath: editorFilePath,
        }),
      });
      const data = await readJsonResponse<SnapshotResponse>(response);
      applySnapshot(data);
      setPrompt("");
    } catch (caughtError) {
      recordComposerError(caughtError, "AI edit failed.");
    } finally {
      setIsRunningAi(false);
    }
  }

  async function handleInspectorAction(action: {
    kind:
      | "replace-text"
      | "set-line-color"
      | "set-fill-color"
      | "set-background-color"
      | "set-spacing"
      | "set-radius"
      | "set-size"
      | "set-visibility"
      | "swap-image";
    value?: string | null;
    axis?: "all" | "x" | "y" | null;
    promptOverride: string;
  }) {
    if (!currentProject?.project.currentRevisionId || !effectiveSelectedElement) {
      return;
    }

    setIsRunningAi(true);
    setError(null);
    clearComposerDiagnostics();
    setFeedback(
      `Applying a precise inspector edit to ${selectedElementTitle(effectiveSelectedElement)} (${selectionScopeLabel(selectionScopeMode).toLowerCase()})...`,
    );

    try {
      const response = await fetch(`/api/projects/${currentProject.project.id}/ai-edit`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          projectId: currentProject.project.id,
          revisionId: currentProject.project.currentRevisionId,
          prompt: action.promptOverride,
          selection: effectiveSelectedElement,
          attachmentIds: selectedAttachmentIds,
          aiModelKey: selectedAiModel?.key || fallbackAiModelKey,
          currentFilePath: editorFilePath,
          inspectorAction: {
            kind: action.kind,
            value: action.value || null,
            axis: action.axis || null,
          },
        }),
      });
      const data = await readJsonResponse<SnapshotResponse>(response);
      applySnapshot(data);
    } catch (caughtError) {
      recordComposerError(caughtError, "Inspector edit failed.");
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
      clearComposerDiagnostics();
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
      clearComposerDiagnostics();
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
    await Promise.allSettled([
      fetch("/api/auth/logout", { method: "POST" }),
      logout(),
    ]);
    window.location.href = "/auth";
  }

  async function handleImportGitHubRepo(repo: GitHubRepoSummary) {
    setIsGitHubSubmitting(true);
    setError(null);
    clearComposerDiagnostics();
    setFeedback(`Importing ${repo.fullName} from GitHub...`);

    try {
      const response = await fetch("/api/github/import", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          owner: repo.owner,
          repo: repo.name,
        }),
      });
      const data = await readJsonResponse<SnapshotResponse>(response);
      applySnapshot(data);
      setIsGitHubModalOpen(false);
      setFeedback(`Imported ${repo.fullName} into MyMake.`);
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "Could not import this GitHub repo.",
      );
    } finally {
      setIsGitHubSubmitting(false);
    }
  }

  async function handleConnectProjectRepo(repo: GitHubRepoSummary) {
    if (!currentProject) {
      return;
    }

    setIsGitHubSubmitting(true);
    setError(null);
    clearComposerDiagnostics();
    setFeedback(`Linking ${currentProject.project.name} to ${repo.fullName}...`);

    try {
      const response = await fetch(
        `/api/projects/${currentProject.project.id}/github/connect`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            mode: "existing",
            owner: repo.owner,
            repo: repo.name,
          }),
        },
      );
      await readJsonResponse<SnapshotResponse>(response);
      const pushResponse = await fetch(
        `/api/projects/${currentProject.project.id}/github/push`,
        {
          method: "POST",
        },
      );
      const data = await readJsonResponse<SnapshotResponse>(pushResponse);
      applySnapshot(data);
      setIsGitHubModalOpen(false);
      setFeedback(`Linked and pushed this project to ${repo.fullName}.`);
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "Could not connect this project to GitHub.",
      );
    } finally {
      setIsGitHubSubmitting(false);
    }
  }

  async function handleCreateGitHubRepo() {
    if (!currentProject || !newGitHubRepoName.trim()) {
      return;
    }

    setIsGitHubSubmitting(true);
    setError(null);
    clearComposerDiagnostics();
    setFeedback(`Creating ${newGitHubRepoName.trim()} on GitHub...`);

    try {
      const response = await fetch(
        `/api/projects/${currentProject.project.id}/github/connect`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            mode: "create",
            name: newGitHubRepoName.trim(),
            isPrivate: newGitHubRepoPrivate,
          }),
        },
      );
      await readJsonResponse<SnapshotResponse>(response);
      const pushResponse = await fetch(
        `/api/projects/${currentProject.project.id}/github/push`,
        {
          method: "POST",
        },
      );
      const data = await readJsonResponse<SnapshotResponse>(pushResponse);
      applySnapshot(data);
      setIsGitHubModalOpen(false);
      setFeedback(`Created, linked, and pushed ${newGitHubRepoName.trim()} on GitHub.`);
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "Could not create the GitHub repo.",
      );
    } finally {
      setIsGitHubSubmitting(false);
    }
  }

  async function handleGitHubPush() {
    if (!currentProject) {
      return;
    }

    if (!githubConnection.connected || !githubBinding) {
      openGitHubModal("connect");
      return;
    }

    setIsGitHubSubmitting(true);
    setError(null);
    clearComposerDiagnostics();
    setFeedback(
      `Pushing ${currentCheckpointLabel} to ${githubBinding.owner}/${githubBinding.repo}...`,
    );

    try {
      const response = await fetch(`/api/projects/${currentProject.project.id}/github/push`, {
        method: "POST",
      });
      const data = await readJsonResponse<SnapshotResponse>(response);
      applySnapshot(data);
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "Could not push this project to GitHub.",
      );
    } finally {
      setIsGitHubSubmitting(false);
    }
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
    clearComposerDiagnostics();
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
  const hasComposerDiagnostics = Boolean(
    error &&
      (composerErrorDetails.length ||
        composerErrorRawOutput ||
        (composerNotice && composerNotice.length > 180)),
  );
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
          codexBridgeReachable={isCodexBridgeReachable}
          feedback={feedback}
          error={error}
          filteredProjects={filteredProjects}
          githubConnection={githubConnection}
          homeQuery={homeQuery}
          onOpenCodexSettings={() => setIsCodexSettingsOpen(true)}
          onImportRepo={() =>
            githubConnection.connected
              ? openGitHubModal("import")
              : startGitHubOAuth("import")
          }
          onDeleteProject={(project) => void handleDeleteProject(project)}
          onLogout={() => void handleLogout()}
          onOpenProject={(projectId) => void handleProjectChange(projectId)}
          onProjectUpload={() => projectUploadInputRef.current?.click()}
          onSearchChange={setHomeQuery}
          onUploadClick={() => projectUploadInputRef.current?.click()}
          projectNameCounts={projectNameCounts}
          totalProjects={snapshot.projects.length}
          viewer={viewer}
        />
        {isGitHubModalOpen ? (
          <GitHubModal
            connection={githubConnection}
            currentProject={currentProject}
            isLoading={isGitHubReposLoading}
            isSubmitting={isGitHubSubmitting}
            mode={gitHubModalMode}
            newRepoName={newGitHubRepoName}
            newRepoPrivate={newGitHubRepoPrivate}
            onClose={() => setIsGitHubModalOpen(false)}
            onConnectGitHub={() => startGitHubOAuth(gitHubModalMode)}
            onCreateRepo={() => void handleCreateGitHubRepo()}
            onImportRepo={(repo) => void handleImportGitHubRepo(repo)}
            onNewRepoNameChange={setNewGitHubRepoName}
            onNewRepoPrivateChange={setNewGitHubRepoPrivate}
            onRepoConnect={(repo) => void handleConnectProjectRepo(repo)}
            onSetMode={setGitHubModalMode}
            repos={gitHubRepos}
          />
        ) : null}
        {isCodexSettingsOpen ? (
          <CodexSettingsModal
            bridgeHealth={codexBridgeHealth}
            draftAutoStart={codexBridgeDraftAutoStart}
            draftMode={codexBridgeDraftMode}
            isReachable={isCodexBridgeReachable}
            isSaving={isCodexSettingsSaving}
            onAutoStartChange={setCodexBridgeDraftAutoStart}
            onClose={() => setIsCodexSettingsOpen(false)}
            onModeChange={setCodexBridgeDraftMode}
            onSave={() => void handleSaveCodexBridgeSettings()}
          />
        ) : null}
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
                label={
                  currentCodexThreadId
                    ? "Open this project's Codex session"
                    : "Open a Codex session for this project"
                }
                active={Boolean(currentCodexThreadId)}
                disabled={!currentProject}
                onClick={() => void handleOpenCodexSession()}
              >
                <ExternalLink className="h-4 w-4" />
              </ToolbarIconButton>
              <ToolbarIconButton
                label={
                  githubBinding
                    ? `Push ${currentCheckpointLabel} to ${githubBinding.owner}/${githubBinding.repo}`
                    : "Connect this project to GitHub"
                }
                active={Boolean(githubBinding)}
                onClick={() => {
                  if (githubBinding && githubConnection.connected) {
                    void handleGitHubPush();
                    return;
                  }

                  openGitHubModal("connect");
                }}
              >
                {isGitHubSubmitting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <GitHubMark className="h-4 w-4" />
                )}
              </ToolbarIconButton>
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
              <ToolbarIconButton
                label="Open Codex settings"
                onClick={() => setIsCodexSettingsOpen(true)}
              >
                <Settings2 className="h-4 w-4" />
              </ToolbarIconButton>
              <UserBadgeButton
                onClick={() => void handleLogout()}
                label={viewer?.displayName || viewer?.email || "A"}
              />
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
                  {selectionSupportsAllMatching(selectedElement) ? (
                    <div className="mt-3 flex items-center gap-2">
                      {(["instance", "all-matching"] as SelectionScopeMode[]).map((mode) => (
                        <button
                          key={mode}
                          className={
                            selectionScopeMode === mode
                              ? "rounded-full border border-[#5f62ff]/40 bg-[#5f62ff]/14 px-2.5 py-1 text-[10px] uppercase tracking-[0.16em] text-white"
                              : "rounded-full border border-white/[0.08] bg-[#262628] px-2.5 py-1 text-[10px] uppercase tracking-[0.16em] text-slate-400 transition hover:text-slate-200"
                          }
                          type="button"
                          disabled={isRunningAi}
                          onClick={() => setSelectionScopeMode(mode)}
                        >
                          {selectionScopeLabel(mode)}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  {selectedElement ? (
                    <div className="mt-2 grid grid-cols-2 gap-2 text-[10px] uppercase tracking-[0.16em] text-slate-500">
                      <div className="rounded-[10px] border border-white/[0.08] bg-[#262628] px-2.5 py-2">
                        <span className="block text-[9px] text-slate-500">Planned lane</span>
                        <span className="mt-1 block text-slate-200">{plannedLaneLabel}</span>
                      </div>
                      <div className="rounded-[10px] border border-white/[0.08] bg-[#262628] px-2.5 py-2">
                        <span className="block text-[9px] text-slate-500">Instance scope</span>
                        <span className="mt-1 block truncate text-slate-200">
                          {selectedElement.instanceScope || selectedElement.scopeSelector || "Exact layer"}
                        </span>
                      </div>
                    </div>
                  ) : null}
                  {selectedElement ? (
                    <div className="mt-3 rounded-[12px] border border-white/[0.08] bg-[#262628] px-3 py-3">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-[10px] uppercase tracking-[0.16em] text-slate-500">Resolved code</p>
                        <span className="text-[10px] uppercase tracking-[0.16em] text-slate-500">
                          {isResolvingSelection
                            ? "Resolving"
                            : resolvedSelectionTarget
                              ? `${Math.round(resolvedSelectionTarget.confidence * 100)}%`
                              : "Pending"}
                        </span>
                      </div>
                      <p className="mt-2 truncate text-sm font-medium text-slate-100">
                        {resolvedSelectionTarget?.sourceFilePath || "No exact source file resolved yet"}
                      </p>
                      <p className="mt-1 text-xs leading-5 text-slate-400">
                        {resolvedSelectionTarget
                          ? `${resolvedSelectionTarget.componentName || "Unknown component"} • ${selectionScopeLabel(resolvedSelectionTarget.scopeMode)}`
                          : "MyMake is mapping this live layer to the most likely code component and file."}
                      </p>
                      {resolvedSelectionTarget ? (
                        <div className="mt-2 flex flex-wrap gap-2 text-[10px] uppercase tracking-[0.14em] text-slate-500">
                          <span className="rounded-full border border-white/[0.08] bg-[#1f2023] px-2 py-1 text-slate-300">
                            {selectionResolutionLabel(resolvedSelectionTarget.resolutionMethod)}
                          </span>
                          {resolvedSelectionTarget.sourceAnchor?.filePath &&
                          resolvedSelectionTarget.sourceAnchor?.line ? (
                            <span className="rounded-full border border-white/[0.08] bg-[#1f2023] px-2 py-1 text-slate-300">
                              {`${resolvedSelectionTarget.sourceAnchor.filePath}:${resolvedSelectionTarget.sourceAnchor.line}`}
                            </span>
                          ) : null}
                        </div>
                      ) : null}
                      {resolvedSelectionTarget?.sourceCandidates?.length ? (
                        <div className="mt-2 flex flex-wrap gap-2">
                          {resolvedSelectionTarget.sourceCandidates.slice(0, 3).map((candidate) => (
                            <span
                              key={candidate.path}
                              className="rounded-full border border-white/[0.08] bg-[#1f2023] px-2 py-1 text-[10px] text-slate-400"
                            >
                              {candidate.path}
                            </span>
                          ))}
                        </div>
                      ) : null}
                      {resolvedProofHandles.length ? (
                        <div className="mt-3 flex flex-wrap gap-2">
                          {resolvedProofHandles.map((handle) => (
                            <span
                              key={`${handle.key}-${handle.value}`}
                              className="rounded-full border border-white/[0.08] bg-[#1f2023] px-2 py-1 text-[10px] text-slate-300"
                            >
                              {`${handle.label}: ${handle.value}`}
                            </span>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                  {selectedElement?.editableProperties?.length ? (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {selectedElement.editableProperties.slice(0, 5).map((item) => (
                        <span
                          key={item}
                          className="rounded-full border border-white/[0.08] bg-[#262628] px-2 py-1 text-[10px] uppercase tracking-[0.14em] text-slate-400"
                        >
                          {item}
                        </span>
                      ))}
                    </div>
                  ) : null}
                  {selectedElement ? (
                    <div className="mt-3 space-y-2 rounded-[12px] border border-white/[0.08] bg-[#262628] px-3 py-3">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-[10px] uppercase tracking-[0.16em] text-slate-500">Inspector</p>
                        <span className="text-[10px] uppercase tracking-[0.16em] text-slate-500">
                          Deterministic first
                        </span>
                      </div>

                      {inspectorCapabilityKeys.has("text") || Boolean(inspectorTextValue.trim()) ? (
                        <div className="space-y-2">
                          <div className="flex items-center justify-between gap-2">
                            <label className="block text-[10px] uppercase tracking-[0.16em] text-slate-500">
                              Text
                            </label>
                            {resolvedHandleValue(resolvedSelectionTarget, "text") ? (
                              <span className="text-[10px] text-slate-500">
                                {resolvedHandleValue(resolvedSelectionTarget, "text")}
                              </span>
                            ) : null}
                          </div>
                          <input
                            className="h-9 w-full rounded-[10px] border border-white/[0.08] bg-[#1f2023] px-3 text-sm text-white outline-none placeholder:text-slate-500"
                            value={inspectorTextValue}
                            onChange={(event) => setInspectorTextValue(event.target.value)}
                          />
                          <button
                            className="w-full rounded-[10px] border border-white/[0.08] bg-[#31323a] px-3 py-2 text-xs font-medium text-white transition hover:bg-[#3a3c46]"
                            type="button"
                            disabled={!inspectorTextValue.trim() || isRunningAi}
                            onClick={() =>
                              void handleInspectorAction({
                                kind: "replace-text",
                                value: inspectorTextValue,
                                promptOverride: `Change this selected text to "${inspectorTextValue}".`,
                              })
                            }
                          >
                            Apply text change
                          </button>
                        </div>
                      ) : null}

                      {inspectorCapabilityKeys.has("line-color") ? (
                        <div className="space-y-2">
                          <div className="flex items-center justify-between gap-2">
                            <label className="block text-[10px] uppercase tracking-[0.16em] text-slate-500">
                              Line color
                            </label>
                            {resolvedHandleValue(resolvedSelectionTarget, "line-color") ? (
                              <span className="text-[10px] text-slate-500">
                                {resolvedHandleValue(resolvedSelectionTarget, "line-color")}
                              </span>
                            ) : null}
                          </div>
                          <div className="flex items-center gap-2">
                            <input
                              className="h-9 w-10 rounded-[10px] border border-white/[0.08] bg-transparent"
                              type="color"
                              value={inspectorLineColor}
                              onChange={(event) => setInspectorLineColor(event.target.value)}
                            />
                            <button
                              className="flex-1 rounded-[10px] border border-white/[0.08] bg-[#31323a] px-3 py-2 text-xs font-medium text-white transition hover:bg-[#3a3c46]"
                              type="button"
                              disabled={isRunningAi}
                              onClick={() =>
                                void handleInspectorAction({
                                  kind: "set-line-color",
                                  value: inspectorLineColor,
                                  promptOverride: `Change only the selected line or stroke color to ${inspectorLineColor}. Do not change any fill or shaded area.`,
                                })
                              }
                            >
                              Apply line color
                            </button>
                          </div>
                        </div>
                      ) : null}

                      {inspectorCapabilityKeys.has("fill-color") ||
                      inspectorCapabilityKeys.has("background") ||
                      Boolean(resolvedHandleValue(resolvedSelectionTarget, "background-color")) ? (
                        <div className="space-y-2">
                          <div className="flex items-center justify-between gap-2">
                            <label className="block text-[10px] uppercase tracking-[0.16em] text-slate-500">
                              Fill or background
                            </label>
                            {resolvedHandleValue(resolvedSelectionTarget, "fill-color") ||
                            resolvedHandleValue(resolvedSelectionTarget, "background-color") ? (
                              <span className="text-[10px] text-slate-500">
                                {resolvedHandleValue(resolvedSelectionTarget, "fill-color") ||
                                  resolvedHandleValue(resolvedSelectionTarget, "background-color")}
                              </span>
                            ) : null}
                          </div>
                          <div className="flex items-center gap-2">
                            <input
                              className="h-9 w-10 rounded-[10px] border border-white/[0.08] bg-transparent"
                              type="color"
                              value={inspectorFillColor}
                              onChange={(event) => setInspectorFillColor(event.target.value)}
                            />
                            <button
                              className="flex-1 rounded-[10px] border border-white/[0.08] bg-[#31323a] px-3 py-2 text-xs font-medium text-white transition hover:bg-[#3a3c46]"
                              type="button"
                              disabled={isRunningAi}
                              onClick={() =>
                                void handleInspectorAction({
                                  kind:
                                    selectedElement.visualType === "chart-area"
                                      ? "set-fill-color"
                                      : "set-background-color",
                                  value: inspectorFillColor,
                                  promptOverride:
                                    selectedElement.visualType === "chart-area"
                                      ? `Change only the selected filled area color to ${inspectorFillColor}.`
                                      : `Change the selected background or fill color to ${inspectorFillColor}.`,
                                })
                              }
                            >
                              Apply fill
                            </button>
                          </div>
                        </div>
                      ) : null}

                      {inspectorCapabilityKeys.has("spacing") ? (
                        <div className="space-y-2">
                          <label className="block text-[10px] uppercase tracking-[0.16em] text-slate-500">
                            Spacing
                          </label>
                          <div className="grid grid-cols-2 gap-2">
                            <div className="space-y-2 rounded-[10px] border border-white/[0.08] bg-[#1f2023] p-2">
                              <span className="block text-[10px] uppercase tracking-[0.14em] text-slate-500">
                                Horizontal
                              </span>
                              <input
                                className="h-9 w-full rounded-[10px] border border-white/[0.08] bg-[#262628] px-3 text-sm text-white outline-none placeholder:text-slate-500"
                                value={inspectorSpacingXValue}
                                onChange={(event) => setInspectorSpacingXValue(event.target.value)}
                                placeholder="16px"
                              />
                              <button
                                className="w-full rounded-[10px] border border-white/[0.08] bg-[#31323a] px-3 py-2 text-xs font-medium text-white transition hover:bg-[#3a3c46]"
                                type="button"
                                disabled={!inspectorSpacingXValue.trim() || isRunningAi}
                                onClick={() =>
                                  void handleInspectorAction({
                                    kind: "set-spacing",
                                    axis: "x",
                                    value: inspectorSpacingXValue,
                                    promptOverride: `Change only the horizontal spacing on this selected element to ${inspectorSpacingXValue}.`,
                                  })
                                }
                              >
                                Apply X spacing
                              </button>
                            </div>
                            <div className="space-y-2 rounded-[10px] border border-white/[0.08] bg-[#1f2023] p-2">
                              <span className="block text-[10px] uppercase tracking-[0.14em] text-slate-500">
                                Vertical
                              </span>
                              <input
                                className="h-9 w-full rounded-[10px] border border-white/[0.08] bg-[#262628] px-3 text-sm text-white outline-none placeholder:text-slate-500"
                                value={inspectorSpacingYValue}
                                onChange={(event) => setInspectorSpacingYValue(event.target.value)}
                                placeholder="16px"
                              />
                              <button
                                className="w-full rounded-[10px] border border-white/[0.08] bg-[#31323a] px-3 py-2 text-xs font-medium text-white transition hover:bg-[#3a3c46]"
                                type="button"
                                disabled={!inspectorSpacingYValue.trim() || isRunningAi}
                                onClick={() =>
                                  void handleInspectorAction({
                                    kind: "set-spacing",
                                    axis: "y",
                                    value: inspectorSpacingYValue,
                                    promptOverride: `Change only the vertical spacing on this selected element to ${inspectorSpacingYValue}.`,
                                  })
                                }
                              >
                                Apply Y spacing
                              </button>
                            </div>
                          </div>
                        </div>
                      ) : null}

                      {inspectorCapabilityKeys.has("radius") ? (
                        <div className="space-y-2">
                          <div className="flex items-center justify-between gap-2">
                            <label className="block text-[10px] uppercase tracking-[0.16em] text-slate-500">
                              Border radius
                            </label>
                            {resolvedHandleValue(resolvedSelectionTarget, "radius") ? (
                              <span className="text-[10px] text-slate-500">
                                {resolvedHandleValue(resolvedSelectionTarget, "radius")}
                              </span>
                            ) : null}
                          </div>
                          <div className="flex items-center gap-2">
                            <input
                              className="h-9 flex-1 rounded-[10px] border border-white/[0.08] bg-[#1f2023] px-3 text-sm text-white outline-none placeholder:text-slate-500"
                              value={inspectorRadiusValue}
                              onChange={(event) => setInspectorRadiusValue(event.target.value)}
                              placeholder="20px"
                            />
                            <button
                              className="rounded-[10px] border border-white/[0.08] bg-[#31323a] px-3 py-2 text-xs font-medium text-white transition hover:bg-[#3a3c46]"
                              type="button"
                              disabled={!inspectorRadiusValue.trim() || isRunningAi}
                              onClick={() =>
                                void handleInspectorAction({
                                  kind: "set-radius",
                                  value: inspectorRadiusValue,
                                  promptOverride: `Set only the selected border radius to ${inspectorRadiusValue}.`,
                                })
                              }
                            >
                              Apply radius
                            </button>
                          </div>
                        </div>
                      ) : null}

                      {inspectorCapabilityKeys.has("typography") ? (
                        <div className="space-y-2">
                          <div className="flex items-center justify-between gap-2">
                            <label className="block text-[10px] uppercase tracking-[0.16em] text-slate-500">
                              Typography size
                            </label>
                            {resolvedHandleValue(resolvedSelectionTarget, "font-size") ? (
                              <span className="text-[10px] text-slate-500">
                                {resolvedHandleValue(resolvedSelectionTarget, "font-size")}
                              </span>
                            ) : null}
                          </div>
                          <div className="flex items-center gap-2">
                            <input
                              className="h-9 flex-1 rounded-[10px] border border-white/[0.08] bg-[#1f2023] px-3 text-sm text-white outline-none placeholder:text-slate-500"
                              value={inspectorFontSizeValue}
                              onChange={(event) => setInspectorFontSizeValue(event.target.value)}
                              placeholder="18px"
                            />
                            <button
                              className="rounded-[10px] border border-white/[0.08] bg-[#31323a] px-3 py-2 text-xs font-medium text-white transition hover:bg-[#3a3c46]"
                              type="button"
                              disabled={!inspectorFontSizeValue.trim() || isRunningAi}
                              onClick={() =>
                                void handleInspectorAction({
                                  kind: "set-size",
                                  value: inspectorFontSizeValue,
                                  promptOverride: `Set only the selected font size to ${inspectorFontSizeValue}.`,
                                })
                              }
                            >
                              Apply type size
                            </button>
                          </div>
                        </div>
                      ) : null}

                      {inspectorCapabilityKeys.has("image") || Boolean(inspectorImageValue) ? (
                        <div className="space-y-2">
                          <div className="flex items-center justify-between gap-2">
                            <label className="block text-[10px] uppercase tracking-[0.16em] text-slate-500">
                              Image source
                            </label>
                            {resolvedHandleValue(resolvedSelectionTarget, "image-src") ? (
                              <span className="max-w-[12rem] truncate text-[10px] text-slate-500">
                                {resolvedHandleValue(resolvedSelectionTarget, "image-src")}
                              </span>
                            ) : null}
                          </div>
                          <input
                            className="h-9 w-full rounded-[10px] border border-white/[0.08] bg-[#1f2023] px-3 text-sm text-white outline-none placeholder:text-slate-500"
                            value={inspectorImageValue}
                            onChange={(event) => setInspectorImageValue(event.target.value)}
                            placeholder="/images/hero.jpg"
                          />
                          <button
                            className="w-full rounded-[10px] border border-white/[0.08] bg-[#31323a] px-3 py-2 text-xs font-medium text-white transition hover:bg-[#3a3c46]"
                            type="button"
                            disabled={!inspectorImageValue.trim() || isRunningAi}
                            onClick={() =>
                              void handleInspectorAction({
                                kind: "swap-image",
                                value: inspectorImageValue,
                                promptOverride: `Replace only the selected image source with ${inspectorImageValue}.`,
                              })
                            }
                          >
                            Apply image swap
                          </button>
                        </div>
                      ) : null}

                      <button
                        className="w-full rounded-[10px] border border-white/[0.08] bg-[#2f2327] px-3 py-2 text-xs font-medium text-rose-100 transition hover:bg-[#3a2a30]"
                        type="button"
                        disabled={isRunningAi}
                        onClick={() =>
                          void handleInspectorAction({
                            kind: "set-visibility",
                            promptOverride: "Hide the selected element.",
                          })
                        }
                      >
                        Hide selected element
                      </button>
                    </div>
                  ) : null}
                </div>

                <div className="rounded-[16px] border border-white/[0.08] bg-[#2f2d2c] px-3.5 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Active kits</p>
                    <span className="text-[10px] uppercase tracking-[0.16em] text-slate-500">
                      {kits.filter((kit) => kit.enabled).length}
                    </span>
                  </div>
                  <div className="mt-2 space-y-2">
                    {kits.filter((kit) => kit.enabled).slice(0, 4).map((kit) => (
                      <div key={kit.id} className="rounded-[12px] border border-white/[0.08] bg-[#262628] px-3 py-2">
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-xs font-medium uppercase tracking-[0.16em] text-slate-300">
                            {kit.name}
                          </p>
                          <span className="text-[10px] uppercase tracking-[0.14em] text-slate-500">
                            {kit.kind}
                          </span>
                        </div>
                        <p className="mt-1 text-xs leading-5 text-slate-400">{kit.summary}</p>
                      </div>
                    ))}
                    {!kits.filter((kit) => kit.enabled).length ? (
                      <p className="text-xs leading-5 text-slate-500">
                        MyMake will populate kits as it learns this project’s runtime, style, and references.
                      </p>
                    ) : null}
                  </div>
                </div>

                <div className="rounded-[16px] border border-white/[0.08] bg-[#2f2d2c] px-3.5 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Context graph</p>
                    <span className="text-[10px] uppercase tracking-[0.14em] text-slate-500">
                      {currentProject.latestContextSnapshot?.sources.length || 0} nodes
                    </span>
                  </div>
                  <p className="mt-2 text-sm text-slate-100">
                    {currentProject.latestContextSnapshot?.primaryTarget || "No context snapshot yet"}
                  </p>
                  <p className="mt-1 text-xs leading-5 text-slate-400">
                    {currentProject.latestContextSnapshot?.compressedMemory
                      ? currentProject.latestContextSnapshot.compressedMemory
                      : "The next AI turn will capture route context, component subtree, kits, and recent edit memory."}
                  </p>
                </div>

                <div>
                  <div className="flex items-center justify-between gap-3 text-[11px] uppercase tracking-[0.24em] text-slate-500">
                    <div>Conversation</div>
                    <span>{orderedRevisions.length} checkpoints</span>
                  </div>

                  <div className="mt-3 space-y-3">
                    {currentProject ? (
                      conversationTurns.map((turn) => {
                        const linkedRevision = turn.revisionId
                          ? revisionById.get(turn.revisionId) || null
                          : null;
                        const isCurrentCheckpoint =
                          Boolean(
                            linkedRevision &&
                              currentProject.project.currentRevisionId === linkedRevision.id,
                          );
                        const hasTurnDiagnostics = Boolean(
                          turn.warnings.length ||
                            turn.validationDetails.length ||
                            turn.rawProviderOutput,
                        );
                        const isTurnExpanded = expandedTurnIds.includes(turn.id);

                        return (
                          <article key={turn.id} className="group space-y-2">
                            {turn.kind === "user" && turn.prompt ? (
                              <div className="flex justify-end">
                                <div className="max-w-[88%] rounded-[18px] border border-[#5f62ff]/28 bg-[#5f62ff]/12 px-3.5 py-3 text-left">
                                  <p className="text-sm leading-6 text-white">{turn.prompt}</p>
                                </div>
                              </div>
                            ) : null}

                            {turn.kind !== "user" ? (
                              <div className="rounded-[18px] border border-white/[0.08] bg-[#2f2d2c] px-3.5 py-3">
                              <div className="flex items-center justify-between gap-3">
                                <div className="flex items-center gap-2">
                                  {linkedRevision ? (
                                    <span className="rounded-full border border-white/[0.08] bg-[#262628] px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-slate-400">
                                      {checkpointLabel(linkedRevision)}
                                    </span>
                                  ) : null}
                                  <span
                                    className={clsx(
                                      "rounded-full border px-2 py-1 text-[10px] uppercase tracking-[0.16em]",
                                      turnStatusClasses(turn),
                                    )}
                                  >
                                    {turnStatusLabel(turn)}
                                  </span>
                                </div>
                                {linkedRevision ? (
                                  isCurrentCheckpoint ? (
                                    <span className="text-[10px] uppercase tracking-[0.16em] text-emerald-200">
                                      Current
                                    </span>
                                  ) : (
                                    <button
                                      className="opacity-0 transition group-hover:opacity-100 text-slate-400 hover:text-white"
                                      type="button"
                                      title={`Restore ${checkpointLabel(linkedRevision)}`}
                                      aria-label={`Restore ${checkpointLabel(linkedRevision)}`}
                                      onClick={() => void handleRestoreRevision(linkedRevision)}
                                    >
                                      <RefreshCcw className="h-3.5 w-3.5" />
                                    </button>
                                  )
                                ) : null}
                              </div>
                              <p className="mt-2 text-sm leading-6 text-[#e7e7ea]">
                                {turn.summary || "No summary available yet."}
                              </p>
                              {turn.selectionTarget?.componentName || turn.selectionTarget?.sourceFilePath ? (
                                <p className="mt-2 text-xs leading-5 text-slate-400">
                                  {[
                                    turn.selectionTarget?.componentName
                                      ? `Component: ${turn.selectionTarget.componentName}`
                                      : null,
                                    turn.selectionTarget?.sourceFilePath
                                      ? `File: ${turn.selectionTarget.sourceFilePath}`
                                      : null,
                                  ]
                                    .filter(Boolean)
                                    .join(" · ")}
                                </p>
                              ) : null}
                              {turn.changedFiles.length ? (
                                <div className="mt-2 flex flex-wrap gap-2">
                                  {turn.changedFiles.slice(0, 3).map((file) => (
                                    <span
                                      key={`${turn.id}-${file.path}`}
                                      className="rounded-full border border-white/[0.08] bg-[#262628] px-2 py-1 text-[10px] uppercase tracking-[0.14em] text-slate-400"
                                    >
                                      {file.path}
                                    </span>
                                  ))}
                                </div>
                              ) : null}
                              {hasTurnDiagnostics ? (
                                <div className="mt-3 border-t border-white/[0.08] pt-3">
                                  <button
                                    className="flex w-full items-center justify-between gap-3 text-left text-[11px] uppercase tracking-[0.16em] text-slate-400 transition hover:text-white"
                                    type="button"
                                    onClick={() => toggleTurnExpansion(turn.id)}
                                  >
                                    <span>
                                      {isTurnExpanded ? "Hide details" : "Show details"}
                                    </span>
                                    <ChevronDown
                                      className={clsx(
                                        "h-3.5 w-3.5 transition",
                                        isTurnExpanded && "rotate-180",
                                      )}
                                    />
                                  </button>

                                  {isTurnExpanded ? (
                                    <div className="mt-3 space-y-3 text-xs leading-5 text-slate-300">
                                      {turn.warnings.length ? (
                                        <div>
                                          <p className="mb-1 text-[10px] uppercase tracking-[0.16em] text-amber-200">
                                            Warnings
                                          </p>
                                          <ul className="space-y-1 text-amber-100/90">
                                            {turn.warnings.map((warning, index) => (
                                              <li key={`${turn.id}-warning-${index}`}>• {warning}</li>
                                            ))}
                                          </ul>
                                        </div>
                                      ) : null}

                                      {turn.validationDetails.length ? (
                                        <div>
                                          <p className="mb-1 text-[10px] uppercase tracking-[0.16em] text-slate-500">
                                            Validation details
                                          </p>
                                          <ul className="space-y-1">
                                            {turn.validationDetails.map((detail, index) => (
                                              <li key={`${turn.id}-detail-${index}`}>• {detail}</li>
                                            ))}
                                          </ul>
                                        </div>
                                      ) : null}

                                      {turn.rawProviderOutput ? (
                                        <div>
                                          <p className="mb-1 text-[10px] uppercase tracking-[0.16em] text-slate-500">
                                            Model output
                                          </p>
                                          <pre className="max-h-48 overflow-auto rounded-[12px] border border-white/[0.08] bg-[#262628] p-3 whitespace-pre-wrap break-words text-[11px] leading-5 text-slate-300">
                                            {turn.rawProviderOutput}
                                          </pre>
                                        </div>
                                      ) : null}
                                    </div>
                                  ) : null}
                                </div>
                              ) : null}
                            </div>
                            ) : null}
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
                  <button
                    className={clsx(
                      "flex w-full items-start justify-between gap-3 text-left",
                      hasComposerDiagnostics && "cursor-pointer",
                    )}
                    type="button"
                    onClick={() => {
                      if (hasComposerDiagnostics) {
                        setIsComposerNoticeExpanded((value) => !value);
                      }
                    }}
                  >
                    <span
                      className={clsx(
                        "min-w-0",
                        hasComposerDiagnostics && !isComposerNoticeExpanded && "line-clamp-2",
                        isComposerNoticeExpanded && "whitespace-pre-wrap break-words",
                      )}
                    >
                      {composerNotice}
                    </span>
                    {hasComposerDiagnostics ? (
                      <ChevronDown
                        className={clsx(
                          "mt-0.5 h-3.5 w-3.5 shrink-0 transition",
                          isComposerNoticeExpanded && "rotate-180",
                        )}
                      />
                    ) : null}
                  </button>

                  {hasComposerDiagnostics && isComposerNoticeExpanded ? (
                    <div className="mt-3 space-y-3 border-t border-white/10 pt-3 text-[11px] leading-5">
                      {composerErrorDetails.length ? (
                        <div>
                          <p className="mb-1 uppercase tracking-[0.16em] text-rose-100/70">
                            Details
                          </p>
                          <ul className="space-y-1">
                            {composerErrorDetails.map((detail, index) => (
                              <li key={`composer-detail-${index}`}>• {detail}</li>
                            ))}
                          </ul>
                        </div>
                      ) : null}

                      {composerErrorRawOutput ? (
                        <div>
                          <p className="mb-1 uppercase tracking-[0.16em] text-rose-100/70">
                            Model output
                          </p>
                          <pre className="max-h-52 overflow-auto rounded-[12px] border border-white/[0.08] bg-black/20 p-3 whitespace-pre-wrap break-words text-[11px] leading-5 text-rose-50/90">
                            {composerErrorRawOutput}
                          </pre>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : null}

              <div className="rounded-[18px] border border-white/[0.08] bg-[#2d2d2f] p-2.5">
                {selectedAiModel?.key === "openai-codex" ? (
                  <div className="mb-2 rounded-[12px] border border-[#7f82ff]/20 bg-[#22232b] px-3 py-2 text-[11px] leading-5 text-slate-300">
                    {isCodexBridgeReachable ? (
                      <>
                        Codex mode is connected locally on this Mac.{" "}
                        <span className="font-semibold text-white">
                          {codexModeSummary || "Always available"}
                        </span>
                        {currentCodexThreadId ? (
                          <>
                            {" "}
                            · Session ready for this project.
                          </>
                        ) : (
                          <>
                            {" "}
                            · MyMake will create or resume the project session automatically on the
                            next Codex run.
                          </>
                        )}
                      </>
                    ) : (
                      <>
                        Codex mode runs locally on this Mac through the MyMake bridge. If it is not
                        running yet, start it with{" "}
                        <span className="font-semibold text-white">{CODEX_BRIDGE_BOOT_COMMAND}</span>.
                      </>
                    )}
                  </div>
                ) : null}
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
                      src={previewFrameSrc || `${currentProject.preview.url}/`}
                      className={clsx(
                        "w-full bg-[#12141a]",
                        isDesktopPreview
                          ? "h-full min-h-0 border-0 shadow-none"
                          : "h-[calc(100vh-76px)] min-h-[620px] rounded-[20px] border border-white/[0.06] shadow-[0_30px_60px_rgba(0,0,0,0.22)]",
                      )}
                      onLoad={() => {
                        const frameWindow = iframeRef.current?.contentWindow;
                        if (!frameWindow || !previewOrigin) {
                          return;
                        }
                        frameWindow.postMessage(
                          {
                            channel: "MYMAKE_PREVIEW_BRIDGE",
                            type: "MYMAKE_PING",
                          },
                          previewOrigin,
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
                                  setPreviewNonce((value) => value + 1);
                                  void refreshProject(currentProject.project.id, editorFilePath);
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

      {isGitHubModalOpen ? (
        <GitHubModal
          connection={githubConnection}
          currentProject={currentProject}
          isLoading={isGitHubReposLoading}
          isSubmitting={isGitHubSubmitting}
          mode={gitHubModalMode}
          newRepoName={newGitHubRepoName}
          newRepoPrivate={newGitHubRepoPrivate}
          onClose={() => setIsGitHubModalOpen(false)}
          onConnectGitHub={() => startGitHubOAuth(gitHubModalMode)}
          onCreateRepo={() => void handleCreateGitHubRepo()}
          onImportRepo={(repo) => void handleImportGitHubRepo(repo)}
          onNewRepoNameChange={setNewGitHubRepoName}
          onNewRepoPrivateChange={setNewGitHubRepoPrivate}
          onRepoConnect={(repo) => void handleConnectProjectRepo(repo)}
          onSetMode={setGitHubModalMode}
          repos={gitHubRepos}
        />
      ) : null}
      {isCodexSettingsOpen ? (
        <CodexSettingsModal
          bridgeHealth={codexBridgeHealth}
          draftAutoStart={codexBridgeDraftAutoStart}
          draftMode={codexBridgeDraftMode}
          isReachable={isCodexBridgeReachable}
          isSaving={isCodexSettingsSaving}
          onAutoStartChange={setCodexBridgeDraftAutoStart}
          onClose={() => setIsCodexSettingsOpen(false)}
          onModeChange={setCodexBridgeDraftMode}
          onSave={() => void handleSaveCodexBridgeSettings()}
        />
      ) : null}
      {sharedInputs}
    </main>
  );
}
