export type PackageManager = "npm" | "pnpm" | "yarn";
export type ProjectStatus = "installing" | "ready" | "error" | "unsupported";
export type RevisionSource = "upload" | "ai" | "manual" | "undo" | "redo";
export type DevicePreset = "desktop" | "tablet" | "mobile";
export type ProjectRuntime = "next" | "vite" | "static";
export type AiProvider = "openai" | "anthropic";
export type AiModelKey =
  | "openai-chatgpt-5-2"
  | "openai-codex"
  | "anthropic-sonnet-4-6";
export type EditMode = "precise" | "scoped" | "creative";
export type MakeKitKind = "code" | "style" | "rules" | "reference";
export type MakeKitSource = "system" | "user" | "imported";
export type ProjectGitHubSource = "imported" | "linked" | "created";
export type ContextSourceKind =
  | "selection"
  | "route"
  | "component"
  | "style"
  | "memory"
  | "kit"
  | "attachment"
  | "conversation"
  | "active-file"
  | "supporting";
export type ValidationCheckStatus = "passed" | "failed" | "warning" | "skipped";
export type ValidationStatus = "passed" | "failed" | "warning";
export type ConversationTurnKind = "user" | "assistant" | "system";
export type ConversationTurnStatus = "pending" | "applied" | "failed" | "info";
export type EditStrategy = "direct-property" | "static-override" | "patch" | "rewrite";
export type EditRisk = "low" | "medium" | "high";

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
  selector: string | null;
  scopeSelector: string | null;
  scopedSelector: string | null;
  nearestFramerName: string | null;
  framerPath: string[];
  tagName: string;
  textContent: string;
  attributes: Record<string, string>;
  classes: string[];
  outerHtml: string;
  boundingBox: BoundingBox;
  role: string | null;
  href: string | null;
  src: string | null;
  editableProperties: string[];
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

export interface GitHubConnectionRecord {
  configured: boolean;
  connected: boolean;
  login: string | null;
  name: string | null;
  avatarUrl: string | null;
}

export interface AppUserRecord {
  id: string;
  email: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  createdAt: string;
  lastSeenAt: string;
}

export interface GitHubRepoSummary {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  cloneUrl: string;
  htmlUrl: string;
  updatedAt: string;
}

export interface ProjectGitHubBindingRecord {
  projectId: string;
  githubConnectionId: string;
  owner: string;
  repo: string;
  branch: string;
  defaultBranch: string;
  remoteUrl: string;
  source: ProjectGitHubSource;
  createdAt: string;
  updatedAt: string;
}

export interface AiModelOption {
  key: AiModelKey;
  label: string;
  provider: AiProvider;
  enabled: boolean;
}

export interface EditableCapability {
  key: string;
  label: string;
  confidence: number;
}

export interface SelectionTarget {
  route: string;
  label: string;
  summary: string;
  sourceFilePath: string | null;
  componentName: string | null;
  sectionName: string | null;
  repeatGroup: string | null;
  editableCapabilities: EditableCapability[];
  payload: SelectionPayload;
}

export interface ContextSourceRecord {
  kind: ContextSourceKind;
  title: string;
  path: string | null;
  reason: string;
  score: number;
  excerpted: boolean;
  relatedToSelection: boolean;
  charCount: number;
}

export interface ContextSnapshotRecord {
  id: string;
  projectId: string;
  revisionId: string | null;
  turnId: string | null;
  tokenBudget: number;
  primaryTarget: string | null;
  compressedMemory: string | null;
  sources: ContextSourceRecord[];
  createdAt: string;
}

export interface MakeKitRecord {
  id: string;
  projectId: string;
  name: string;
  kind: MakeKitKind;
  source: MakeKitSource;
  enabled: boolean;
  priority: number;
  summary: string;
  lockedRules: string[];
  softRules: string[];
  assets: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ValidationResultRecord {
  id: string;
  projectId: string;
  revisionId: string | null;
  turnId: string | null;
  status: ValidationStatus;
  buildStatus: ValidationCheckStatus;
  previewStatus: ValidationCheckStatus;
  selectorStatus: ValidationCheckStatus;
  importsStatus: ValidationCheckStatus;
  designStatus: ValidationCheckStatus;
  warnings: string[];
  details: string[];
  rawProviderOutput: string | null;
  retryable: boolean;
  createdAt: string;
}

export interface ConversationTurnRecord {
  id: string;
  projectId: string;
  revisionId: string | null;
  kind: ConversationTurnKind;
  status: ConversationTurnStatus;
  prompt: string | null;
  summary: string | null;
  aiModelKey: AiModelKey | null;
  provider: AiProvider | null;
  editMode: EditMode | null;
  selectionTarget: SelectionTarget | null;
  changedFiles: TurnChangedFile[];
  warnings: string[];
  validationDetails: string[];
  rawProviderOutput: string | null;
  contextSnapshotId: string | null;
  validationResultId: string | null;
  createdAt: string;
}

export interface EditPlan {
  mode: EditMode;
  target: SelectionTarget | null;
  strategy: EditStrategy;
  risk: EditRisk;
  candidateFiles: string[];
  validationSet: string[];
  rationale: string[];
}

export interface ProjectWorkspace {
  project: ProjectRecord;
  revisions: RevisionRecord[];
  conversationTurns: ConversationTurnRecord[];
  attachments: AttachmentRecord[];
  kits: MakeKitRecord[];
  githubBinding: ProjectGitHubBindingRecord | null;
  fileTree: FileNode[];
  currentFilePath: string | null;
  currentFileContent: string | null;
  latestContextSnapshot: ContextSnapshotRecord | null;
  lastValidationResult: ValidationResultRecord | null;
  preview: PreviewDescriptor;
}

export interface DashboardSnapshot {
  viewer: AppUserRecord | null;
  projects: ProjectRecord[];
  currentProjectId: string | null;
  currentProject: ProjectWorkspace | null;
  githubConnection: GitHubConnectionRecord;
  aiModels: AiModelOption[];
  defaultAiModelKey: AiModelKey;
}

export interface AiEditRequestPayload {
  projectId: string;
  revisionId: string;
  prompt: string;
  selection: SelectionPayload | null;
  attachmentIds: string[];
  editMode?: EditMode | null;
  aiModelKey?: AiModelKey | null;
  currentFilePath?: string | null;
}

export interface AiChangedFile {
  path: string;
  content: string;
  reason?: string;
}

export interface TurnChangedFile {
  path: string;
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
