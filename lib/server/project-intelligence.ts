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
  EditIntent,
  EditIntentKind,
  EditMode,
  EditPlan,
  MakeKitRecord,
  PackageManager,
  ProjectRuntime,
  ResolvedHandle,
  SelectionPayload,
  SelectionSourceCandidate,
  SelectionTarget,
  ValidationCheckStatus,
} from "@/lib/types";

export const MYMAKE_DIR = ".mymake";
export const PROJECT_BRIEF_PATH = `${MYMAKE_DIR}/project_brief.md`;
export const DESIGN_RULES_PATH = `${MYMAKE_DIR}/design_rules.md`;
export const BRAND_KIT_PATH = `${MYMAKE_DIR}/brand_kit.json`;
export const COMPONENT_INDEX_PATH = `${MYMAKE_DIR}/component_index.json`;
export const EDIT_MEMORY_PATH = `${MYMAKE_DIR}/edit_memory.json`;

const HIDDEN_DIRS = new Set([
  ".git",
  ".next",
  "node_modules",
  "__MACOSX",
  "dist",
  "build",
  MYMAKE_DIR,
]);
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

  if (
    selection.editableProperties.includes("line-color") ||
    Boolean(selection.attributes.stroke) ||
    selection.visualType === "chart-line"
  ) {
    add("line-color", "Line color", 0.96);
    add("color", "Colors", 0.86);
  }

  if (
    selection.editableProperties.includes("fill-color") ||
    Boolean(selection.attributes.fill) ||
    selection.visualType === "chart-area"
  ) {
    add("fill-color", "Fill color", 0.94);
    add("background", "Background", 0.84);
    add("color", "Colors", 0.82);
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

function buildSelectionFingerprint(selection: SelectionPayload): string {
  if (selection.fingerprint) {
    return selection.fingerprint;
  }

  return createHash("sha1")
    .update(
      JSON.stringify({
        route: selection.route,
        selector: selection.selector,
        scopeSelector: selection.scopeSelector,
        scopedSelector: selection.scopedSelector,
        text: selection.textContent.slice(0, 160),
        framerPath: selection.framerPath,
        reactComponentStack: selection.reactComponentStack || [],
        reactSourceHints: selection.reactSourceHints || [],
      }),
    )
    .digest("hex");
}

function inferSelectionLabel(selection: SelectionPayload): string {
  const trimmedText = selection.textContent.replace(/\s+/g, " ").trim();
  return (
    selection.nearestFramerName ||
    selection.contextTexts?.find((value) => value.trim()) ||
    trimmedText.slice(0, 80) ||
    humanizeIdentifier(selection.tagName)
  );
}

function inferResolvedHandles(selection: SelectionPayload): ResolvedHandle[] {
  const handles = new Map<string, ResolvedHandle>();
  const add = (key: string, label: string, confidence: number, currentValue?: string | null) => {
    const previous = handles.get(key);
    if (!previous || previous.confidence < confidence) {
      handles.set(key, {
        key,
        label,
        confidence,
        currentValue: currentValue || null,
      });
    }
  };

  if (selection.textContent.trim()) {
    add("text", "Text content", 0.96, selection.textContent.trim().slice(0, 120));
  }
  if (selection.attributes.stroke) {
    add("line-color", "Line color", 0.98, selection.attributes.stroke);
  }
  if (selection.attributes.fill && selection.attributes.fill !== "none") {
    add("fill-color", "Fill color", 0.96, selection.attributes.fill);
  }
  if (selection.attributes["background-color"]) {
    add("background-color", "Background", 0.9, selection.attributes["background-color"]);
  }
  if (selection.src) {
    add("image", "Image source", 0.95, selection.src);
  }
  if (selection.editableProperties.includes("spacing")) {
    add("spacing", "Spacing", 0.78);
  }
  if (selection.editableProperties.includes("radius")) {
    add("radius", "Border radius", 0.74);
  }
  add("visibility", "Visibility", 0.9);

  return [...handles.values()].sort((left, right) => right.confidence - left.confidence);
}

function normalizeHintValue(value: string): string {
  return humanizeIdentifier(value)
    .toLowerCase()
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-z0-9]+/g, "");
}

function collectSelectionSearchTerms(selection: SelectionPayload): string[] {
  return unique([
    selection.nearestFramerName || "",
    selection.textContent || "",
    ...(selection.contextTexts || []),
    ...(selection.reactComponentStack || []),
    ...(selection.reactSourceHints || []),
    ...selection.framerPath,
    ...selection.classes,
    selection.visualType || "",
  ])
    .flatMap((value) => splitKeywords(value))
    .filter(Boolean);
}

function collectSelectionPhrases(selection: SelectionPayload): string[] {
  return unique([
    selection.nearestFramerName || "",
    selection.textContent || "",
    ...(selection.contextTexts || []),
    ...(selection.reactComponentStack || []),
    ...(selection.reactSourceHints || []).filter((value) => !/\.[a-z0-9]+$/i.test(value)),
  ])
    .map((value) => value.replace(/\s+/g, " ").trim())
    .filter((value) => value.length >= 3)
    .slice(0, 8);
}

function scoreFileCandidate(params: {
  filePath: string;
  content: string | null;
  route: string;
  currentFilePath: string | null | undefined;
  selection: SelectionPayload;
  componentIndex: ComponentIndexFile;
  routeCandidates: Set<string>;
  searchTerms: string[];
  phrases: string[];
}): SelectionSourceCandidate {
  const matchedTerms = new Set<string>();
  const reasons: string[] = [];
  let score = 0;
  const normalizedFileIdentifier = normalizeHintValue(fileStem(params.filePath));
  const normalizedContent = params.content?.toLowerCase() || null;
  const reactHintMatches = unique([
    ...(params.selection.reactComponentStack || []),
    ...(params.selection.reactSourceHints || []),
  ]).filter((hint) => {
    const normalizedHint = normalizeHintValue(hint);
    return (
      Boolean(normalizedHint) &&
      (normalizedHint.includes(normalizedFileIdentifier) ||
        normalizedFileIdentifier.includes(normalizedHint))
    );
  });

  if (params.routeCandidates.has(params.filePath)) {
    score += 28;
    reasons.push("matches current route");
  }
  if (params.currentFilePath && params.filePath === params.currentFilePath) {
    score += 18;
    reasons.push("active editor file");
  }
  if (reactHintMatches.length) {
    score += 110;
    reasons.push("matches React source hint");
    reactHintMatches.forEach((hint) => splitKeywords(hint).forEach((term) => matchedTerms.add(term)));
  }

  const componentEntries = params.componentIndex.components.filter(
    (entry) => entry.filePath === params.filePath,
  );
  for (const entry of componentEntries) {
    if (entry.route === params.route) {
      score += 16;
      reasons.push("component mapped to route");
    }
    if (
      (params.selection.reactComponentStack || []).some((hint) =>
        normalizeHintValue(hint).includes(normalizeHintValue(entry.name)) ||
        normalizeHintValue(entry.name).includes(normalizeHintValue(hint)),
      )
    ) {
      score += 46;
      reasons.push("component name matches React stack");
    }
    for (const term of params.searchTerms) {
      if (entry.keywords.includes(term)) {
        score += 14;
        matchedTerms.add(term);
      }
    }
  }

  if (normalizedContent) {
    let phraseHits = 0;
    for (const phrase of params.phrases) {
      if (normalizedContent.includes(phrase.toLowerCase())) {
        phraseHits += 1;
        score += 34;
        reasons.push(`contains "${phrase.slice(0, 48)}"`);
      }
    }

    for (const term of params.searchTerms) {
      if (normalizedContent.includes(term)) {
        score += 4;
        matchedTerms.add(term);
      }
    }
    if (phraseHits >= 2) {
      score += 24;
      reasons.push("matches multiple target phrases");
    }

    if (
      params.selection.visualType === "chart-line" &&
      /\b(line|stroke|chart|trend|spark)\b/i.test(normalizedContent)
    ) {
      score += 24;
      reasons.push("contains chart line styling");
    }
    if (
      params.selection.visualType === "chart-area" &&
      /\b(area|fill|gradient|chart)\b/i.test(normalizedContent)
    ) {
      score += 20;
      reasons.push("contains chart fill styling");
    }
    if (params.selection.attributes.stroke && params.content?.includes(params.selection.attributes.stroke)) {
      score += 22;
      reasons.push("contains current stroke value");
    }
    if (
      params.selection.attributes.fill &&
      params.selection.attributes.fill !== "none" &&
      params.content?.includes(params.selection.attributes.fill)
    ) {
      score += 18;
      reasons.push("contains current fill value");
    }
    if (
      params.selection.instanceScope &&
      params.selection.visualType === "chart-line" &&
      phraseHits === 0 &&
      params.routeCandidates.has(params.filePath)
    ) {
      score -= 22;
      reasons.push("route-level file lacks selected instance anchors");
    }
  }

  return {
    path: params.filePath,
    score,
    reason: unique(reasons).slice(0, 4).join("; ") || "supporting selection context",
    matchedTerms: [...matchedTerms].slice(0, 8),
  };
}

function inferConfidenceFromCandidates(
  candidates: SelectionSourceCandidate[],
  selection: SelectionPayload,
): number {
  const top = candidates[0];
  if (!top) {
    return 0.18;
  }

  let confidence = Math.min(0.98, 0.2 + top.score / 180);
  if (top.reason.includes("contains")) {
    confidence += 0.08;
  }
  if (top.reason.includes("React source hint")) {
    confidence += 0.16;
  }
  if (top.reason.includes("matches multiple target phrases")) {
    confidence += 0.08;
  }
  if (selection.attributes.stroke && top.reason.includes("stroke")) {
    confidence += 0.06;
  }
  if (selection.textContent && top.reason.includes("contains")) {
    confidence += 0.06;
  }
  const next = candidates[1];
  if (next) {
    const gap = top.score - next.score;
    if (gap >= 35) {
      confidence += 0.08;
    } else if (gap <= 10) {
      confidence -= 0.08;
    }
  }

  return Math.max(0.12, Math.min(0.98, confidence));
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

  const files = await walkProjectFiles(params.projectDir);
  const routeCandidates = new Set(routeFileCandidates(params.route));
  const searchTerms = collectSelectionSearchTerms(selection);
  const phrases = collectSelectionPhrases(selection);
  const seededFiles = unique(
    [
      ...files.filter((filePath) => routeCandidates.has(filePath)),
      params.currentFilePath || "",
      ...params.componentIndex.components
        .filter((entry) => {
          if (entry.route === params.route) {
            return true;
          }
          return searchTerms.some((term) => entry.keywords.includes(term));
        })
        .map((entry) => entry.filePath),
    ].filter(Boolean),
  );
  const candidateFiles = unique([...seededFiles, ...files]).slice(0, Math.max(20, seededFiles.length + 8));
  const sourceCandidates = (
    await Promise.all(
      candidateFiles.map(async (filePath) =>
        scoreFileCandidate({
          filePath,
          content: await readTextFile(params.projectDir, filePath),
          route: params.route,
          currentFilePath: params.currentFilePath,
          selection,
          componentIndex: params.componentIndex,
          routeCandidates,
          searchTerms,
          phrases,
        }),
      ),
    )
  )
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .slice(0, 5);

  const likelySourceFilePath =
    sourceCandidates[0]?.path || params.currentFilePath || routeFileCandidates(params.route)[0] || null;

  const componentName =
    params.componentIndex.components.find((entry) => entry.filePath === likelySourceFilePath)?.name ||
    (selection.nearestFramerName ? humanizeIdentifier(selection.nearestFramerName) : humanizeIdentifier(selection.tagName));
  const fingerprint = buildSelectionFingerprint(selection);
  const confidence = inferConfidenceFromCandidates(sourceCandidates, selection);
  const repeatGroup = guessRepeatGroup(selection);
  const instanceScope =
    selection.instanceScope ||
    selection.scopeSelector ||
    (repeatGroup ? humanizeIdentifier(repeatGroup) : null);

  return {
    targetId: createHash("sha1")
      .update(`${selection.route}:${fingerprint}:${likelySourceFilePath || "none"}`)
      .digest("hex")
      .slice(0, 16),
    fingerprint,
    route: selection.route,
    label: inferSelectionLabel(selection),
    summary:
      selection.contextTexts?.join(" / ") ||
      selection.textContent ||
      selection.nearestFramerName ||
      selection.scopedSelector ||
      selection.selector ||
      selection.domPath,
    sourceFilePath: likelySourceFilePath,
    sourceCandidates,
    confidence,
    componentName,
    sectionName:
      selection.framerPath.at(-1) ||
      selection.nearestFramerName ||
      humanizeIdentifier(selection.route === "/" ? "Home" : selection.route),
    repeatGroup,
    instanceScope,
    visualType: selection.visualType || null,
    resolvedHandles: inferResolvedHandles(selection),
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

    const rankedCandidate = params.selectionTarget?.sourceCandidates.find(
      (candidate) => candidate.path === filePath,
    );
    if (rankedCandidate) {
      addFileScore(
        filePath,
        "selection",
        140 + Math.min(42, rankedCandidate.score),
        `Resolved target candidate: ${rankedCandidate.reason}`,
      );
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
    .slice(0, params.selectionTarget ? 8 : 12);

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

function extractColorValue(prompt: string): string | null {
  const hexMatch = prompt.match(/#[0-9a-f]{3,8}\b/i);
  if (hexMatch?.[0]) {
    return hexMatch[0];
  }

  const namedColorMatch = prompt.match(
    /\b(red|green|blue|white|black|gray|grey|orange|yellow|purple|pink|emerald|teal|cyan)\b/i,
  );
  return namedColorMatch?.[1] || null;
}

const COLOR_NAME_TO_HEX: Record<string, string> = {
  red: "#ef4444",
  green: "#22c55e",
  blue: "#3b82f6",
  white: "#ffffff",
  black: "#000000",
  gray: "#9ca3af",
  grey: "#9ca3af",
  orange: "#f97316",
  yellow: "#facc15",
  purple: "#8b5cf6",
  pink: "#ec4899",
  emerald: "#10b981",
  teal: "#14b8a6",
  cyan: "#06b6d4",
};

function normalizeColorToken(raw: string | null): string | null {
  if (!raw) {
    return null;
  }

  if (/^#[0-9a-f]{3,8}$/i.test(raw)) {
    return raw;
  }

  return COLOR_NAME_TO_HEX[raw.toLowerCase()] || raw.toLowerCase();
}

function extractDirectionalTrendInstruction(prompt: string): {
  upColor: string;
  downColor: string;
  lineOnly: boolean;
} | null {
  const normalized = prompt.toLowerCase();
  if (!/\b(upward|uptrend|up trend|upward trend|upward trends|higher|rising|positive)\b/.test(normalized)) {
    return null;
  }
  if (!/\b(downward|downtrend|down trend|downward trend|downward trends|lower|falling|negative)\b/.test(normalized)) {
    return null;
  }

  const colorPattern = /(#[0-9a-f]{3,8}\b|red|green|blue|white|black|gray|grey|orange|yellow|purple|pink|emerald|teal|cyan)/i;
  const upMatch = prompt.match(
    new RegExp(
      String.raw`\b(?:upward|uptrend|up trend|upward trend|upward trends|higher|rising|positive)\b[\s\S]{0,40}?${colorPattern.source}`,
      "i",
    ),
  );
  const downMatch = prompt.match(
    new RegExp(
      String.raw`\b(?:downward|downtrend|down trend|downward trend|downward trends|lower|falling|negative)\b[\s\S]{0,40}?${colorPattern.source}`,
      "i",
    ),
  );

  const colorMentions = [...prompt.matchAll(new RegExp(colorPattern.source, "gi"))].map((match) =>
    normalizeColorToken(match[0]),
  );

  const upColor = normalizeColorToken(upMatch?.at(-1) || null) || colorMentions.find(Boolean) || "#22c55e";
  let downColor =
    normalizeColorToken(downMatch?.at(-1) || null) ||
    colorMentions.find((value) => value && value !== upColor) ||
    null;

  if (!downColor && upColor === "#22c55e") {
    downColor = "#ef4444";
  }

  if (!downColor) {
    return null;
  }

  const lineOnly =
    /\bonly\b[\s\S]{0,24}\bline/.test(normalized) ||
    /\bonly\b[\s\S]{0,24}\bstroke/.test(normalized) ||
    /\bnot\b[\s\S]{0,36}\b(shade|shades|fill|area|gradient)/.test(normalized) ||
    /\bwithout\b[\s\S]{0,24}\b(fill|area|gradient|shade)/.test(normalized);

  return {
    upColor,
    downColor,
    lineOnly,
  };
}

function resolveEditIntent(params: {
  prompt: string;
  target: SelectionTarget | null;
  inspectorAction?: { kind: string; value?: string | null } | null;
}): EditIntent {
  if (params.inspectorAction) {
    return {
      kind: params.inspectorAction.kind as EditIntentKind,
      confidence: 0.99,
      requestedValue: params.inspectorAction.value || null,
      summary: `Inspector action: ${params.inspectorAction.kind}`,
    };
  }

  const prompt = params.prompt;
  const target = params.target;
  const normalized = prompt.toLowerCase();
  const hasQuotedReplacementIntent =
    /\b(change|replace|rename)\b[\s\S]*["“'`].+?["”'`][\s\S]*\b(to|with)\b[\s\S]*["“'`]?.+$/i.test(
      prompt,
    );

  if (!target && !hasQuotedReplacementIntent) {
    return { kind: "unknown", confidence: 0.18, summary: "No stable target resolved yet." };
  }

  if (/\b(remove|delete|hide)\b/.test(normalized)) {
    return {
      kind: "set-visibility",
      confidence: 0.92,
      requestedValue: "hidden",
      summary: "Hide or remove the selected target.",
    };
  }

  if (
    (hasQuotedReplacementIntent ||
      (/\b(change|replace|rename)\b/.test(normalized) &&
        Boolean(target?.editableCapabilities.some((item) => item.key === "text"))))
  ) {
    return {
      kind: "replace-text",
      confidence: 0.9,
      summary: "Replace the selected text content.",
    };
  }

  const directionalTrendInstruction = extractDirectionalTrendInstruction(prompt);
  if (
    directionalTrendInstruction &&
    target?.visualType === "chart-line" &&
    Boolean(target.resolvedHandles.some((handle) => handle.key === "line-color"))
  ) {
    return {
      kind: "set-directional-trend-colors",
      confidence: 0.95,
      requestedValue: JSON.stringify(directionalTrendInstruction),
      summary: "Update upward and downward trend line colors for the selected chart.",
    };
  }

  const requestedColor = extractColorValue(prompt);
  if (
    requestedColor &&
    /\b(line|stroke|sparkline|chart line|trend line)\b/.test(normalized) &&
    Boolean(target?.resolvedHandles.some((handle) => handle.key === "line-color"))
  ) {
    return {
      kind: "set-line-color",
      confidence: 0.9,
      requestedValue: requestedColor,
      currentValue:
        target?.resolvedHandles.find((handle) => handle.key === "line-color")?.currentValue || null,
      summary: "Update only the line or stroke color.",
    };
  }

  if (
    requestedColor &&
    /\b(fill|shade|background|area|card background)\b/.test(normalized) &&
    Boolean(
      target?.resolvedHandles.some(
        (handle) => handle.key === "fill-color" || handle.key === "background-color",
      ),
    )
  ) {
    return {
      kind:
        target?.resolvedHandles.some((handle) => handle.key === "background-color")
          ? "set-background-color"
          : "set-fill-color",
      confidence: 0.86,
      requestedValue: requestedColor,
      summary: "Update the selected fill or background color.",
    };
  }

  if (
    /\b(radius|rounded|corner)\b/.test(normalized) &&
    Boolean(target?.editableCapabilities.some((item) => item.key === "radius"))
  ) {
    return {
      kind: "set-radius",
      confidence: 0.8,
      summary: "Adjust border radius on the selected target.",
    };
  }

  if (
    /\b(gap|padding|margin|spacing)\b/.test(normalized) &&
    Boolean(target?.editableCapabilities.some((item) => item.key === "spacing"))
  ) {
    return {
      kind: "set-spacing",
      confidence: 0.8,
      summary: "Adjust spacing on the selected target.",
    };
  }

  return {
    kind: "unknown",
    confidence: target ? Math.max(0.42, target.confidence - 0.08) : 0.22,
    summary: "This edit likely needs a constrained AI pass.",
  };
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
  inspectorAction?: { kind: string; value?: string | null } | null;
}): EditPlan {
  const resolvedEditMode =
    params.editMode ||
    inferEditMode({
      prompt: params.prompt,
        selectionTarget: params.selectionTarget,
        runtime: params.runtime,
      });
  const intent = resolveEditIntent({
    prompt: params.prompt,
    target: params.selectionTarget,
    inspectorAction: params.inspectorAction,
  });
  const isLargeActiveFile = Boolean(params.currentFileContent && params.currentFileContent.length > 120_000);
  const confidence = params.selectionTarget
    ? Math.min(0.99, (params.selectionTarget.confidence + intent.confidence) / 2)
    : intent.confidence;
  const allowedFiles = unique(
    [
      params.selectionTarget?.sourceFilePath || "",
      ...(params.selectionTarget?.sourceCandidates || []).map((candidate) => candidate.path),
      ...params.contextGraph.candidateFiles.slice(0, resolvedEditMode === "creative" ? 8 : 5),
    ].filter(Boolean),
  );
  const allowedProperties = unique(
    [
      ...((params.selectionTarget?.resolvedHandles || []).map((handle) => handle.key)),
      intent.kind,
    ].filter(Boolean),
  );
  const lane =
    intent.kind !== "unknown" && confidence >= 0.72
      ? "deterministic"
      : params.selectionTarget && confidence >= 0.48
        ? "scoped-ai"
        : "deep-fix";
  const strategy =
    lane === "deterministic"
      ? "direct-property"
      : params.runtime === "static" && params.hasStaticEditableSupport && params.selectionTarget
        ? "static-override"
        : lane === "deep-fix" || isLargeActiveFile || resolvedEditMode === "precise"
          ? "patch"
          : "rewrite";

  const risk =
    lane === "deterministic" || strategy === "static-override"
      ? "low"
      : lane === "deep-fix" || resolvedEditMode === "creative"
        ? "high"
        : "medium";

  const rationale = [
    params.selectionTarget
      ? `Targeting ${params.selectionTarget.label} on ${params.selectionTarget.route} with ${(confidence * 100).toFixed(0)}% confidence.`
      : "No exact element selected, so the edit will use route and file context.",
    `Edit mode is ${resolvedEditMode}.`,
    `Execution lane is ${lane}.`,
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
    lane,
    intent,
    risk,
    candidateFiles: params.contextGraph.candidateFiles.slice(0, resolvedEditMode === "creative" ? 8 : 5),
    allowedFiles,
    allowedProperties,
    confidence,
    requiresConfirmation: Boolean(params.selectionTarget) && confidence < 0.4,
    validationSet: ["imports", "preview", ...(params.selectionTarget ? ["selector"] : []), "design", "target"],
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
