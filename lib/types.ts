export type PackageManager = "npm" | "pnpm" | "yarn";
export type ProjectStatus = "installing" | "ready" | "error" | "unsupported";
export type RevisionSource = "upload" | "ai" | "manual" | "undo" | "redo";
export type DevicePreset = "desktop" | "tablet" | "mobile";
export type ProjectRuntime = "next" | "vite";
export type AiProvider = "openai" | "anthropic";
export type AiModelKey = "openai-chatgpt-5-2" | "anthropic-sonnet-4-6";

export interface ProjectRecord {
  id: string;
  name: string;
  sourceZipPath: string;
  extractedPath: string;
  packageManager: PackageManager;
  status: ProjectStatus;
  currentRevisionId: string | null;
  manifestHash: string | null;
  previewPort: number | null;
  lastOpenedAt: string;
  createdAt: string;
}

export interface RevisionRecord {
  id: string;
  projectId: string;
  parentRevisionId: string | null;
  label: string;
  source: RevisionSource;
  snapshotPath: string;
  sequence: number;
  summary: string | null;
  createdAt: string;
}

export interface AttachmentRecord {
  id: string;
  projectId: string;
  filename: string;
  mimeType: string;
  storagePath: string;
  sizeBytes: number;
  createdAt: string;
}

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SelectionPayload {
  route: string;
  url: string;
  domPath: string;
  tagName: string;
  textContent: string;
  attributes: Record<string, string>;
  classes: string[];
  outerHtml: string;
  boundingBox: BoundingBox;
}

export interface FileNode {
  name: string;
  path: string;
  type: "directory" | "file";
  editable: boolean;
  children?: FileNode[];
}

export interface PreviewDescriptor {
  url: string;
  status: "ready" | "starting" | "error";
  port: number | null;
  instanceId: string | null;
}

export interface AiModelOption {
  key: AiModelKey;
  label: string;
  provider: AiProvider;
  enabled: boolean;
}

export interface ProjectWorkspace {
  project: ProjectRecord;
  revisions: RevisionRecord[];
  attachments: AttachmentRecord[];
  fileTree: FileNode[];
  currentFilePath: string | null;
  currentFileContent: string | null;
  preview: PreviewDescriptor;
}

export interface DashboardSnapshot {
  projects: ProjectRecord[];
  currentProjectId: string | null;
  currentProject: ProjectWorkspace | null;
  aiModels: AiModelOption[];
  defaultAiModelKey: AiModelKey;
}

export interface AiEditRequestPayload {
  projectId: string;
  revisionId: string;
  prompt: string;
  selection: SelectionPayload | null;
  attachmentIds: string[];
  aiModelKey?: AiModelKey | null;
  currentFilePath?: string | null;
}

export interface AiChangedFile {
  path: string;
  content: string;
  reason?: string;
}

export interface AiEditResponsePayload {
  summary: string;
  changedFiles: AiChangedFile[];
  newRevisionId: string;
  warnings: string[];
}

export interface AnthropicAttachment {
  id: string;
  filename: string;
  mimeType: string;
  data: Buffer;
}
