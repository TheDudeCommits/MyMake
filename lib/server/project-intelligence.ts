import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type { ContextFile } from "@/lib/server/anthropic";
import {
  isTextLikeFile,
  resolveInsideRoot,
  toPosixPath,
} from "@/lib/server/path-utils";
import type {
  AttachmentRecord,
  ContextSourceKind,
  ContextSourceRecord,
  ConversationTurnRecord,
  EditMode,
  EditPlan,
  MakeKitRecord,
  PackageManager,
  ProjectRuntime,
  SelectionPayload,
  SelectionTarget,
  ValidationCheckStatus,
} from "@/lib/types";

export const MYMAKE_DIR = ".mymake";
export const PROJECT_BRIEF_PATH = `${MYMAKE_DIR}/project_brief.md`;
export const DESIGN_RULES_PATH = `${MYMAKE_DIR}/design_rules.md`;
export const BRAND_KIT_PATH = `${MYMAKE_DIR}/brand_kit.json`;
export const COMPONENT_INDEX_PATH = `${MYMAKE_DIR}/component_index.json`;
export const EDIT_MEMORY_PATH = `${MYMAKE_DIR}/edit_memory.json`;

const HIDDEN_DIRS = new Set([".git", ".next", "node_modules", "__MACOSX", MYMAKE_DIR]);
const STYLE_FILE_HINTS = [
  "globals.css",
  "tailwind",
  "theme.css",
  "theme.ts",
  "tokens",
  "styles/",
  "style.",
];

interface ComponentIndexEntry {
  name: string;
  filePath: string;
  route: string | null;
  kind: "route" | "component" | "style" | "template";
  keywords: string[];
}

interface ComponentIndexFile {
  generatedAt: string;
  projectFingerprint: string;
  components: ComponentIndexEntry[];
}

interface EditMemoryFile {
  generatedAt: string;
  successfulEdits: Array<{
    prompt: string;
    summary: string;
    editMode: EditMode;
    target: string | null;
    changedFiles: string[];
    createdAt: string;
  }>;
  keepRules: string[];
  avoidRules: string[];
  preferredPatterns: string[];
}

interface BrandKitFile {
  generatedAt: string;
  palette: string[];
  fonts: string[];
  primitives: string[];
}

export interface KnowledgeArtifacts {
  projectBriefPath: string;
  designRulesPath: string;
  brandKitPath: string;
  componentIndexPath: string;
  editMemoryPath: string;
}

export interface ContextGraphResult {
  selectionTarget: SelectionTarget | null;
  contextFiles: ContextFile[];
  sources: ContextSourceRecord[];
  tokenBudget: number;
  compressedMemory: string | null;
  primaryTarget: string | null;
  candidateFiles: string[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function humanizeIdentifier(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function fileStem(relativePath: string): string {
  return path.basename(relativePath).replace(/\.[^.]+$/, "");
}

function splitKeywords(value: string): string[] {
  return humanizeIdentifier(value)
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((part) => part.length >= 3);
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function routeFileCandidates(route: string): string[] {
  const normalizedRoute = route === "/" ? "" : route.replace(/^\/+|\/+$/g, "");
  const parts = normalizedRoute ? normalizedRoute.split("/") : [];
  const candidates = [
    "app/layout.tsx",
    "app/globals.css",
    "pages/_app.tsx",
    "src/app/App.tsx",
    "src/app/App.jsx",
    "src/App.tsx",
    "src/App.jsx",
    "src/main.tsx",
    "src/main.jsx",
    "index.html",
  ];

  if (!parts.length) {
    return unique([...candidates, "app/page.tsx", "pages/index.tsx", "pages/index.jsx"]);
  }

  const joined = parts.join("/");
  return unique([
    ...candidates,
    `app/${joined}/page.tsx`,
    `app/${joined}/layout.tsx`,
    `pages/${joined}.tsx`,
    `pages/${joined}.jsx`,
    `pages/${joined}/index.tsx`,
    `pages/${joined}/index.jsx`,
  ]);
}

async function walkProjectFiles(
  root: string,
  current = root,
  output: string[] = [],
): Promise<string[]> {
  const entries = await fs.readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (HIDDEN_DIRS.has(entry.name) || entry.name === ".DS_Store") {
      continue;
    }

    const absolutePath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      await walkProjectFiles(root, absolutePath, output);
      continue;
    }

    output.push(toPosixPath(path.relative(root, absolutePath)));
  }

  return output.sort();
}

async function readTextFile(projectDir: string, relativePath: string): Promise<string | null> {
  const absolutePath = resolveInsideRoot(projectDir, relativePath);
  if (!isTextLikeFile(absolutePath)) {
    return null;
  }

  try {
    return await fs.readFile(absolutePath, "utf8");
  } catch {
    return null;
  }
}

async function fileExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function ensureInternalDir(projectDir: string): Promise<string> {
  const targetDir = path.join(projectDir, MYMAKE_DIR);
  await fs.mkdir(targetDir, { recursive: true });
  return targetDir;
}

function extractHexPalette(content: string): string[] {
  return unique((content.match(/#[0-9a-f]{3,8}\b/gi) || []).map((item) => item.toLowerCase())).slice(
    0,
    24,
  );
}

function extractFonts(content: string): string[] {
  const fonts = new Set<string>();
  for (const match of content.matchAll(/font-family\s*:\s*([^;]+);/gi)) {
    const raw = match[1] || "";
    raw
      .split(",")
      .map((item) => item.replace(/['"]/g, "").trim())
      .filter(Boolean)
      .slice(0, 3)
      .forEach((font) => fonts.add(font));
  }
  return [...fonts].slice(0, 16);
}

function deriveComponentKind(filePath: string): ComponentIndexEntry["kind"] {
  if (filePath.endsWith(".css") || STYLE_FILE_HINTS.some((hint) => filePath.includes(hint))) {
    return "style";
  }

  if (filePath.includes("app/") || filePath.includes("pages/") || filePath.endsWith("index.html")) {
    return "route";
  }

  if (filePath.toLowerCase().includes("template")) {
    return "template";
  }

  return "component";
}

function routeForFile(filePath: string): string | null {
  if (filePath === "app/page.tsx" || filePath === "pages/index.tsx" || filePath === "index.html") {
    return "/";
  }

  const appMatch = filePath.match(/^app\/(.+)\/page\.[jt]sx?$/);
  if (appMatch?.[1]) {
    return `/${appMatch[1].replace(/\/index$/, "")}`;
  }

  const pagesMatch = filePath.match(/^pages\/(.+?)\.[jt]sx?$/);
  if (pagesMatch?.[1]) {
    return `/${pagesMatch[1].replace(/\/index$/, "")}`;
  }

  return null;
}

async function buildComponentIndex(projectDir: string): Promise<ComponentIndexFile> {
  const files = await walkProjectFiles(projectDir);
  const components: ComponentIndexEntry[] = [];

  for (const filePath of files) {
    const text = await readTextFile(projectDir, filePath);
    const stem = fileStem(filePath);
    const keywords = new Set<string>(splitKeywords(stem));

    if (text) {
      for (const match of text.matchAll(
        /\b(?:export\s+(?:default\s+)?function|export\s+const|function|const)\s+([A-Z][A-Za-z0-9]+)/g,
      )) {
        const name = match[1];
        if (name) {
          splitKeywords(name).forEach((keyword) => keywords.add(keyword));
        }
      }

      if (text.includes("data-framer-name")) {
        for (const match of text.matchAll(/data-framer-name=["']([^"']+)["']/g)) {
          if (match[1]) {
            splitKeywords(match[1]).forEach((keyword) => keywords.add(keyword));
          }
        }
      }
    }

    components.push({
      name: humanizeIdentifier(stem),
      filePath,
      route: routeForFile(filePath),
      kind: deriveComponentKind(filePath),
      keywords: [...keywords].slice(0, 20),
    });
  }

  const fingerprint = createHash("sha1").update(files.join("|")).digest("hex");
  return {
    generatedAt: nowIso(),
    projectFingerprint: fingerprint,
    components,
  };
}

async function readJsonFile<T>(projectDir: string, relativePath: string): Promise<T | null> {
  const absolutePath = resolveInsideRoot(projectDir, relativePath);
  if (!(await fileExists(absolutePath))) {
    return null;
  }

  try {
    return JSON.parse(await fs.readFile(absolutePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function defaultProjectBrief(params: {
  projectName: string;
  runtime: ProjectRuntime;
  packageManager: PackageManager;
}): string {
  return `# Project Brief

Project: ${params.projectName}
Audience: personal-first internal design work
Runtime: ${params.runtime}
Package manager: ${params.packageManager}

Goals
- Keep the app fast to edit and preview.
- Preserve the existing visual language unless a prompt asks for a broader redesign.
- Prefer precise, reversible changes over broad rewrites.

Tone
- Polished
- Efficient
- Product-minded
`;
}

function defaultDesignRules(): string {
  return `# Design Rules

Locked rules
- Preserve route structure and component wiring unless the prompt explicitly asks for a refactor.
- Prefer existing tokens, CSS variables, and utility classes over new ad hoc styling.
- Avoid layout shifts that create excess empty space.

Soft rules
- Keep spacing rhythm consistent.
- Match the existing typography and motion style before introducing a new one.
- For broader redesigns, keep the UI dense, legible, and responsive.
`;
}

function defaultEditMemory(): EditMemoryFile {
  return {
    generatedAt: nowIso(),
    successfulEdits: [],
    keepRules: [],
    avoidRules: [],
    preferredPatterns: [],
  };
}

async function deriveBrandKit(projectDir: string): Promise<BrandKitFile> {
  const files = await walkProjectFiles(projectDir);
  const palette = new Set<string>();
  const fonts = new Set<string>();
  const primitives = new Set<string>();

  for (const filePath of files) {
    if (!STYLE_FILE_HINTS.some((hint) => filePath.includes(hint)) && !filePath.endsWith(".css")) {
      continue;
    }

    const content = await readTextFile(projectDir, filePath);
    if (!content) {
      continue;
    }

    extractHexPalette(content).forEach((item) => palette.add(item));
    extractFonts(content).forEach((font) => fonts.add(font));
    ["button", "card", "badge", "input", "modal", "hero", "navbar"]
      .filter((item) => new RegExp(item, "i").test(content))
      .forEach((item) => primitives.add(item));
  }

  return {
    generatedAt: nowIso(),
    palette: [...palette].slice(0, 16),
    fonts: [...fonts].slice(0, 12),
    primitives: [...primitives].slice(0, 12),
  };
}

export async function ensureProjectKnowledgeArtifacts(params: {
  projectDir: string;
  projectName: string;
  runtime: ProjectRuntime;
  packageManager: PackageManager;
}): Promise<KnowledgeArtifacts> {
  await ensureInternalDir(params.projectDir);

  const projectBriefPath = resolveInsideRoot(params.projectDir, PROJECT_BRIEF_PATH);
  const designRulesPath = resolveInsideRoot(params.projectDir, DESIGN_RULES_PATH);
  const brandKitPath = resolveInsideRoot(params.projectDir, BRAND_KIT_PATH);
  const componentIndexPath = resolveInsideRoot(params.projectDir, COMPONENT_INDEX_PATH);
  const editMemoryPath = resolveInsideRoot(params.projectDir, EDIT_MEMORY_PATH);

  if (!(await fileExists(projectBriefPath))) {
    await fs.writeFile(
      projectBriefPath,
      defaultProjectBrief({
        projectName: params.projectName,
        runtime: params.runtime,
        packageManager: params.packageManager,
      }),
      "utf8",
    );
  }

  if (!(await fileExists(designRulesPath))) {
    await fs.writeFile(designRulesPath, defaultDesignRules(), "utf8");
  }

  if (!(await fileExists(brandKitPath))) {
    await fs.writeFile(
      brandKitPath,
      JSON.stringify(await deriveBrandKit(params.projectDir), null, 2),
      "utf8",
    );
  }

  await fs.writeFile(
    componentIndexPath,
    JSON.stringify(await buildComponentIndex(params.projectDir), null, 2),
    "utf8",
  );

  if (!(await fileExists(editMemoryPath))) {
    await fs.writeFile(editMemoryPath, JSON.stringify(defaultEditMemory(), null, 2), "utf8");
  }

  return {
    projectBriefPath: PROJECT_BRIEF_PATH,
    designRulesPath: DESIGN_RULES_PATH,
    brandKitPath: BRAND_KIT_PATH,
    componentIndexPath: COMPONENT_INDEX_PATH,
    editMemoryPath: EDIT_MEMORY_PATH,
  };
}

export async function readKnowledgeFiles(projectDir: string): Promise<{
  projectBrief: string;
  designRules: string;
  brandKit: BrandKitFile;
  componentIndex: ComponentIndexFile;
  editMemory: EditMemoryFile;
}> {
  const projectBrief =
    (await readTextFile(projectDir, PROJECT_BRIEF_PATH)) || defaultProjectBrief({
      projectName: "Untitled project",
      runtime: "static",
      packageManager: "npm",
    });
  const designRules = (await readTextFile(projectDir, DESIGN_RULES_PATH)) || defaultDesignRules();
  const brandKit =
    (await readJsonFile<BrandKitFile>(projectDir, BRAND_KIT_PATH)) || (await deriveBrandKit(projectDir));
  const componentIndex =
    (await readJsonFile<ComponentIndexFile>(projectDir, COMPONENT_INDEX_PATH)) ||
    (await buildComponentIndex(projectDir));
  const editMemory =
    (await readJsonFile<EditMemoryFile>(projectDir, EDIT_MEMORY_PATH)) || defaultEditMemory();

  return {
    projectBrief,
    designRules,
    brandKit,
    componentIndex,
    editMemory,
  };
}

function inferEditableCapabilities(selection: SelectionPayload): SelectionTarget["editableCapabilities"] {
  const capabilities = new Map<string, { label: string; confidence: number }>();
  const add = (key: string, label: string, confidence: number) => {
    const previous = capabilities.get(key);
    if (!previous || previous.confidence < confidence) {
      capabilities.set(key, { label, confidence });
    }
  };

  if (selection.textContent.trim()) {
    add("text", "Copy", 0.95);
    add("typography", "Typography", 0.8);
  }

  if (selection.tagName === "img" || selection.src) {
    add("image", "Image", 0.95);
  }

  if (selection.tagName === "a" || selection.href) {
    add("link", "Link", 0.92);
  }

  if (["button", "a"].includes(selection.tagName) || /\bbutton\b/i.test(selection.classes.join(" "))) {
    add("spacing", "Spacing", 0.82);
    add("radius", "Radius", 0.74);
    add("color", "Colors", 0.8);
  }

  add("visibility", "Visibility", 0.9);
  add("layout", "Layout", 0.68);

  return [...capabilities.entries()].map(([key, value]) => ({
    key,
    label: value.label,
    confidence: value.confidence,
  }));
}

function guessRepeatGroup(selection: SelectionPayload): string | null {
  const candidates = [
    selection.nearestFramerName || "",
    ...selection.classes,
    selection.domPath,
  ];

  for (const candidate of candidates) {
    const normalized = candidate.toLowerCase();
    if (/(card|item|tile|row|list|grid|slide|badge)/.test(normalized)) {
      return humanizeIdentifier(candidate);
    }
  }

  return null;
}

export async function buildSelectionTarget(params: {
  projectDir: string;
  route: string;
  currentFilePath: string | null | undefined;
  selection: SelectionPayload | null;
  componentIndex: ComponentIndexFile;
}): Promise<SelectionTarget | null> {
  const { selection } = params;
  if (!selection) {
    return null;
  }

  const searchTerms = unique([
    selection.nearestFramerName || "",
    selection.textContent || "",
    ...selection.framerPath,
    ...selection.classes,
  ])
    .flatMap((value) => splitKeywords(value))
    .filter(Boolean);

  const files = await walkProjectFiles(params.projectDir);
  const routeCandidates = new Set(routeFileCandidates(params.route));
  const fileScores = new Map<string, number>();

  const scoreFile = (filePath: string, amount: number) => {
    fileScores.set(filePath, (fileScores.get(filePath) || 0) + amount);
  };

  for (const file of files) {
    if (routeCandidates.has(file)) {
      scoreFile(file, 60);
    }
    if (params.currentFilePath && file === params.currentFilePath) {
      scoreFile(file, 50);
    }
  }

  for (const entry of params.componentIndex.components) {
    let score = 0;
    if (entry.route === params.route) {
      score += 30;
    }
    for (const term of searchTerms) {
      if (entry.keywords.includes(term)) {
        score += 18;
      }
    }
    if (score > 0) {
      scoreFile(entry.filePath, score);
    }
  }

  const likelySourceFilePath =
    [...fileScores.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ||
    params.currentFilePath ||
    null;

  const componentName =
    params.componentIndex.components.find((entry) => entry.filePath === likelySourceFilePath)?.name ||
    (selection.nearestFramerName ? humanizeIdentifier(selection.nearestFramerName) : humanizeIdentifier(selection.tagName));

  return {
    route: selection.route,
    label: selection.nearestFramerName || componentName || selection.tagName,
    summary:
      selection.textContent ||
      selection.nearestFramerName ||
      selection.scopedSelector ||
      selection.selector ||
      selection.domPath,
    sourceFilePath: likelySourceFilePath,
    componentName,
    sectionName:
      selection.framerPath.at(-1) ||
      selection.nearestFramerName ||
      humanizeIdentifier(selection.route === "/" ? "Home" : selection.route),
    repeatGroup: guessRepeatGroup(selection),
    editableCapabilities: inferEditableCapabilities(selection),
    payload: selection,
  };
}

function excerptContent(params: {
  content: string;
  prompt: string;
  selection: SelectionPayload | null;
  filePath: string;
}): string {
  const { content, prompt, selection } = params;
  if (content.length <= 18_000) {
    return content;
  }

  const anchors = new Set<number>([0]);
  const candidatePhrases = unique([
    selection?.textContent || "",
    selection?.nearestFramerName || "",
    ...prompt.match(/"([^"]+)"/g)?.map((value) => value.replace(/"/g, "")) || [],
    ...prompt.split(/[^a-z0-9]+/gi).filter((item) => item.length >= 6),
  ]);

  for (const phrase of candidatePhrases) {
    const index = content.indexOf(phrase);
    if (index >= 0) {
      anchors.add(index);
    }
  }

  const windows = [...anchors]
    .slice(0, 4)
    .map((anchor) => ({
      start: Math.max(0, anchor - 3200),
      end: Math.min(content.length, anchor + 9400),
    }))
    .sort((left, right) => left.start - right.start);

  const merged: Array<{ start: number; end: number }> = [];
  for (const window of windows) {
    const previous = merged.at(-1);
    if (previous && window.start <= previous.end + 300) {
      previous.end = Math.max(previous.end, window.end);
      continue;
    }
    merged.push(window);
  }

  return merged
    .map(
      (window, index) =>
        `/* MYMAKE CONTEXT ${index + 1} FROM ${params.filePath} bytes ${window.start}-${window.end} */\n${content.slice(window.start, window.end)}`,
    )
    .join("\n\n");
}

function buildRecentMemory(turns: ConversationTurnRecord[], editMemory: EditMemoryFile): string | null {
  const lines: string[] = [];
  for (const turn of turns.filter((item) => item.kind === "assistant" && item.status === "applied").slice(-4)) {
    if (turn.summary) {
      lines.push(`- ${turn.summary}`);
    }
  }

  if (editMemory.keepRules.length) {
    lines.push(`Keep: ${editMemory.keepRules.slice(0, 4).join("; ")}`);
  }
  if (editMemory.avoidRules.length) {
    lines.push(`Avoid: ${editMemory.avoidRules.slice(0, 4).join("; ")}`);
  }
  if (editMemory.preferredPatterns.length) {
    lines.push(`Patterns: ${editMemory.preferredPatterns.slice(0, 4).join("; ")}`);
  }

  if (!lines.length) {
    return null;
  }

  return lines.join("\n");
}

export async function collectContextGraph(params: {
  projectDir: string;
  route: string;
  currentFilePath: string | null | undefined;
  prompt: string;
  selection: SelectionPayload | null;
  selectionTarget: SelectionTarget | null;
  kits: MakeKitRecord[];
  recentTurns: ConversationTurnRecord[];
  attachments: AttachmentRecord[];
}): Promise<ContextGraphResult> {
  const knowledge = await readKnowledgeFiles(params.projectDir);
  const visibleFiles = await walkProjectFiles(params.projectDir);
  const sources: ContextSourceRecord[] = [];
  const fileScores = new Map<string, { score: number; reason: string; kind: ContextSourceKind }>();
  const addFileScore = (
    filePath: string,
    kind: ContextSourceKind,
    score: number,
    reason: string,
  ) => {
    const previous = fileScores.get(filePath);
    if (!previous || previous.score < score) {
      fileScores.set(filePath, { score, reason, kind });
    } else if (previous.score === score && previous.reason !== reason) {
      previous.reason = `${previous.reason}; ${reason}`;
    }
  };

  const routeCandidates = new Set(routeFileCandidates(params.route));
  const promptTerms = unique(splitKeywords(params.prompt));

  for (const filePath of visibleFiles) {
    if (routeCandidates.has(filePath)) {
      addFileScore(filePath, "route", 120, "Current route file");
    }

    if (params.currentFilePath && filePath === params.currentFilePath) {
      addFileScore(filePath, "active-file", 132, "Active editor file");
    }

    if (
      params.selectionTarget?.sourceFilePath &&
      filePath === params.selectionTarget.sourceFilePath
    ) {
      addFileScore(filePath, "selection", 150, "Likely source file for the selected element");
    }

    if (STYLE_FILE_HINTS.some((hint) => filePath.includes(hint))) {
      addFileScore(filePath, "style", 88, "Shared style or theme context");
    }

    for (const term of promptTerms) {
      if (filePath.toLowerCase().includes(term)) {
        addFileScore(filePath, "supporting", 52, `Path matches prompt term "${term}"`);
      }
    }
  }

  for (const component of knowledge.componentIndex.components) {
    let score = 0;
    if (component.route === params.route) {
      score += 35;
    }
    if (params.selectionTarget?.componentName && component.name === params.selectionTarget.componentName) {
      score += 44;
    }
    if (params.selectionTarget?.repeatGroup && component.keywords.some((value) => params.selectionTarget?.repeatGroup?.toLowerCase().includes(value))) {
      score += 18;
    }
    for (const term of promptTerms) {
      if (component.keywords.includes(term)) {
        score += 12;
      }
    }
    if (score > 0) {
      addFileScore(component.filePath, "component", 70 + score, "Component subtree context");
    }
  }

  addFileScore(PROJECT_BRIEF_PATH, "memory", 96, "Project brief and intent memory");
  addFileScore(DESIGN_RULES_PATH, "memory", 100, "Design rules and constraints");
  addFileScore(BRAND_KIT_PATH, "kit", 94, "Brand kit and token memory");
  addFileScore(COMPONENT_INDEX_PATH, "memory", 82, "Semantic component index");
  addFileScore(EDIT_MEMORY_PATH, "memory", 91, "Prior successful edit memory");

  const compressedMemory = buildRecentMemory(params.recentTurns, knowledge.editMemory);
  if (compressedMemory) {
    sources.push({
      kind: "conversation",
      title: "Recent successful edits",
      path: null,
      reason: "Compressed memory from recent accepted changes",
      score: 88,
      excerpted: false,
      relatedToSelection: Boolean(params.selectionTarget),
      charCount: compressedMemory.length,
    });
  }

  for (const kit of params.kits.filter((item) => item.enabled).sort((left, right) => right.priority - left.priority).slice(0, 4)) {
    sources.push({
      kind: "kit",
      title: kit.name,
      path: null,
      reason: kit.summary,
      score: 86 + Math.max(0, Math.min(12, kit.priority / 10)),
      excerpted: false,
      relatedToSelection: false,
      charCount: kit.summary.length,
    });
  }

  for (const attachment of params.attachments.slice(0, 4)) {
    sources.push({
      kind: "attachment",
      title: attachment.filename,
      path: attachment.storagePath,
      reason: "Attached reference context",
      score: 104,
      excerpted: false,
      relatedToSelection: Boolean(params.selectionTarget),
      charCount: attachment.sizeBytes,
    });
  }

  const orderedFiles = [...fileScores.entries()]
    .sort((left, right) => right[1].score - left[1].score || left[0].localeCompare(right[0]))
    .slice(0, 12);

  const contextFiles: ContextFile[] = [];
  let totalChars = 0;
  const maxChars = 92_000;

  for (const [filePath, meta] of orderedFiles) {
    const content = await readTextFile(params.projectDir, filePath);
    if (!content) {
      continue;
    }

    const prepared = excerptContent({
      content,
      prompt: params.prompt,
      selection: params.selection,
      filePath,
    });

    if (contextFiles.length && totalChars + prepared.length > maxChars) {
      break;
    }

    contextFiles.push({
      path: filePath,
      content: prepared,
      reason: meta.reason,
    });
    totalChars += prepared.length;
    sources.push({
      kind: meta.kind,
      title: humanizeIdentifier(fileStem(filePath)),
      path: filePath,
      reason: meta.reason,
      score: meta.score,
      excerpted: prepared !== content,
      relatedToSelection: filePath === params.selectionTarget?.sourceFilePath,
      charCount: prepared.length,
    });
  }

  return {
    selectionTarget: params.selectionTarget,
    contextFiles,
    sources: sources.sort((left, right) => right.score - left.score),
    tokenBudget: 120_000,
    compressedMemory,
    primaryTarget:
      params.selectionTarget?.label || params.selection?.nearestFramerName || params.route,
    candidateFiles: orderedFiles.map(([filePath]) => filePath),
  };
}

function findDirectPropertyIntent(
  prompt: string,
  target: SelectionTarget | null,
): { type: "text" | "remove" | null; confidence: number } {
  const normalized = prompt.toLowerCase();
  const hasQuotedReplacementIntent =
    /\b(change|replace|rename)\b[\s\S]*["“'`].+?["”'`][\s\S]*\b(to|with)\b[\s\S]*["“'`]?.+$/i.test(
      prompt,
    );

  if (!target && !hasQuotedReplacementIntent) {
    return { type: null, confidence: 0 };
  }

  if (/\b(remove|delete|hide)\b/.test(normalized)) {
    return { type: "remove", confidence: 0.92 };
  }

  if (
    (hasQuotedReplacementIntent ||
      (/\b(change|replace|rename)\b/.test(normalized) &&
        Boolean(target?.editableCapabilities.some((item) => item.key === "text"))))
  ) {
    return { type: "text", confidence: 0.88 };
  }

  return { type: null, confidence: 0 };
}

export function inferEditMode(params: {
  prompt: string;
  selectionTarget: SelectionTarget | null;
  runtime: ProjectRuntime;
}): EditMode {
  const normalized = params.prompt.trim().toLowerCase();

  if (
    /\b(redesign|reimagine|overhaul|rework|explore|concept|creative|hero|landing page|brand refresh|color scheme|theme|palette|visual direction|make it feel)\b/.test(
      normalized,
    )
  ) {
    return "creative";
  }

  if (
    /\b(remove|delete|hide|rename|replace|change|update|swap|set|increase|decrease|tighten|loosen|move|align|resize|make)\b/.test(
      normalized,
    ) &&
    (params.selectionTarget ||
      /\b(this|it|selected|top left|top-right|bottom left|bottom-right|button|card|heading|title|navbar|logo|hero|section)\b/.test(
        normalized,
      ))
  ) {
    return "precise";
  }

  if (params.runtime === "static" && /\b(change|replace|rename)\b/.test(normalized)) {
    return "precise";
  }

  if (params.selectionTarget) {
    return "scoped";
  }

  return "scoped";
}

export function buildEditPlan(params: {
  currentFilePath: string | null | undefined;
  currentFileContent: string | null;
  editMode?: EditMode | null;
  prompt: string;
  runtime: ProjectRuntime;
  selectionTarget: SelectionTarget | null;
  contextGraph: ContextGraphResult;
  hasStaticEditableSupport: boolean;
}): EditPlan {
  const resolvedEditMode =
    params.editMode ||
    inferEditMode({
      prompt: params.prompt,
      selectionTarget: params.selectionTarget,
      runtime: params.runtime,
    });
  const directIntent = findDirectPropertyIntent(params.prompt, params.selectionTarget);
  const isLargeActiveFile = Boolean(params.currentFileContent && params.currentFileContent.length > 120_000);
  const strategy =
    directIntent.type === "text"
      ? "direct-property"
      : params.runtime === "static" && params.hasStaticEditableSupport && params.selectionTarget
        ? "static-override"
        : isLargeActiveFile || resolvedEditMode === "precise"
          ? "patch"
          : "rewrite";

  const risk =
    strategy === "direct-property" || strategy === "static-override"
      ? "low"
      : resolvedEditMode === "creative"
        ? "high"
        : "medium";

  const rationale = [
    params.selectionTarget
      ? `Targeting ${params.selectionTarget.label} on ${params.selectionTarget.route}.`
      : "No exact element selected, so the edit will use route and file context.",
    `Edit mode is ${resolvedEditMode}.`,
    strategy === "patch"
      ? "Using patch mode to constrain file changes."
      : strategy === "rewrite"
        ? "Using rewrite mode because the change likely spans multiple structures."
        : strategy === "static-override"
          ? "Using static override mode for precise Framer/static edits."
          : "Using direct property mode for a simple targeted change.",
  ];

  return {
    mode: resolvedEditMode,
    target: params.selectionTarget,
    strategy,
    risk,
    candidateFiles: params.contextGraph.candidateFiles.slice(0, resolvedEditMode === "creative" ? 8 : 5),
    validationSet: ["imports", "preview", ...(params.selectionTarget ? ["selector"] : []), "design"],
    rationale,
  };
}

export function buildDesignValidation(params: {
  prompt: string;
  editMode: EditMode;
  changedFiles: Array<{ path: string; content: string }>;
  brandKit: BrandKitFile;
}): {
  status: ValidationCheckStatus;
  warnings: string[];
  details: string[];
} {
  const warnings: string[] = [];
  const details: string[] = [];

  const introducedColors = unique(
    params.changedFiles.flatMap((file) => extractHexPalette(file.content)),
  );

  if (params.editMode !== "creative" && introducedColors.length > Math.max(8, params.brandKit.palette.length + 2)) {
    warnings.push("The edit introduced a broader color spread than the existing brand kit suggests.");
  }

  if (
    params.editMode === "creative" &&
    !/redesign|theme|visual|style|layout|hero|landing|brand/i.test(params.prompt)
  ) {
    warnings.push("Creative mode was used for a prompt that looks more incremental than exploratory.");
  }

  if (warnings.length) {
    details.push(...warnings);
    return {
      status: "warning",
      warnings,
      details,
    };
  }

  details.push("Design check passed with no obvious token or density regressions.");
  return {
    status: "passed",
    warnings,
    details,
  };
}

function appendPreference(target: string[], value: string): string[] {
  const normalized = humanizeIdentifier(value).trim();
  if (!normalized || target.some((item) => item.toLowerCase() === normalized.toLowerCase())) {
    return target;
  }
  return [...target, normalized].slice(-8);
}

export async function updateEditMemory(params: {
  projectDir: string;
  prompt: string;
  summary: string;
  editMode: EditMode;
  target: SelectionTarget | null;
  changedFiles: string[];
  createdAt: string;
}): Promise<void> {
  const existing =
    (await readJsonFile<EditMemoryFile>(params.projectDir, EDIT_MEMORY_PATH)) ||
    defaultEditMemory();

  const next: EditMemoryFile = {
    ...existing,
    generatedAt: nowIso(),
    successfulEdits: [
      ...existing.successfulEdits.slice(-11),
      {
        prompt: params.prompt,
        summary: params.summary,
        editMode: params.editMode,
        target: params.target?.label || null,
        changedFiles: params.changedFiles,
        createdAt: params.createdAt,
      },
    ],
    keepRules: existing.keepRules,
    avoidRules: existing.avoidRules,
    preferredPatterns: existing.preferredPatterns,
  };

  const keepMatch = params.prompt.match(/\b(?:keep|preserve|maintain)\s+(.+?)(?:\.|,|$)/i);
  if (keepMatch?.[1]) {
    next.keepRules = appendPreference(next.keepRules, keepMatch[1]);
  }

  const avoidMatch = params.prompt.match(/\b(?:avoid|don't|do not)\s+(.+?)(?:\.|,|$)/i);
  if (avoidMatch?.[1]) {
    next.avoidRules = appendPreference(next.avoidRules, avoidMatch[1]);
  }

  const preferredPattern = params.target?.repeatGroup || params.target?.componentName || "";
  if (preferredPattern) {
    next.preferredPatterns = appendPreference(next.preferredPatterns, preferredPattern);
  }

  await fs.writeFile(
    resolveInsideRoot(params.projectDir, EDIT_MEMORY_PATH),
    JSON.stringify(next, null, 2),
    "utf8",
  );
}

export function describeKitAssets(kits: MakeKitRecord[]): string[] {
  return kits
    .filter((kit) => kit.enabled)
    .sort((left, right) => right.priority - left.priority)
    .slice(0, 4)
    .map((kit) => `${kit.name}: ${kit.summary}`);
}
