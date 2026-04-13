import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  ComponentNode,
  ComponentPropertyDefinition,
  ComponentSetNode,
  GetFileResponse,
  GetLocalVariablesResponse,
  LocalVariable,
  Node,
  SubcanvasNode,
} from "@figma/rest-api-spec/dist/api_types";

import {
  serializeFigmaDesignContext,
  type FileResponse,
} from "@/lib/figma/design-context-serializer";

const DEFAULT_GUIDELINE_BUDGET = 4000;
const GUIDELINES_FILE = "Guidelines.md";
const OVERVIEW_COMPONENTS_FILE = "overview-components.md";
const OVERVIEW_TOKENS_FILE = "overview-tokens.md";
const COMPONENTS_DIR = "components";
const TOKENS_DIR = "design-tokens";
const TOKEN_FILES = ["colors.md", "typography.md", "spacing.md", "misc.md"] as const;
const PATTERN_KEYWORDS = [
  "hero",
  "navbar",
  "header",
  "footer",
  "sidebar",
  "modal",
  "dialog",
  "dropdown",
  "menu",
  "table",
  "chart",
  "dashboard",
  "form",
  "pricing",
  "landing",
  "settings",
  "auth",
  "responsive",
  "mobile",
  "tablet",
  "dark",
  "light",
];
const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "this",
  "that",
  "from",
  "into",
  "your",
  "make",
  "using",
  "used",
  "have",
  "when",
  "what",
  "want",
  "need",
  "over",
  "only",
  "should",
  "must",
  "they",
  "them",
  "then",
  "than",
  "just",
  "also",
  "will",
  "read",
  "strictly",
]);

type GuidelineKind = "routing" | "overview" | "component" | "token" | "misc";
type TokenCategory = "colors" | "typography" | "spacing" | "misc";

export interface GuidelineStoreOptions {
  rootDir?: string;
}

export interface GuidelineRouterOptions {
  tokenBudget?: number;
  embeddingProvider?: EmbeddingProvider;
}

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
}

export interface GuidelineDocument {
  relativePath: string;
  absolutePath: string;
  title: string;
  content: string;
  kind: GuidelineKind;
  keywords: string[];
  tokenEstimate: number;
}

interface RankedGuideline extends GuidelineDocument {
  priority: number;
  keywordScore: number;
  embeddingScore: number;
  totalScore: number;
}

interface TokenBudgetUsage {
  used: number;
  budget: number;
}

interface ComponentDocEntry {
  relativePath: string;
  name: string;
  description: string;
  variants: string[];
  properties: string[];
}

interface TokenSummaryEntry {
  category: TokenCategory;
  name: string;
  value: string;
}

interface FigmaLibraryResponses {
  file: GetFileResponse;
  localVariables: GetLocalVariablesResponse | null;
}

export class GuidelineStore {
  readonly rootDir: string;

  constructor(options: GuidelineStoreOptions = {}) {
    this.rootDir = options.rootDir ?? path.join(process.cwd(), "guidelines");
    this.ensureStructure();
  }

  ensureStructure(): void {
    fs.mkdirSync(this.rootDir, { recursive: true });
    fs.mkdirSync(path.join(this.rootDir, COMPONENTS_DIR), { recursive: true });
    fs.mkdirSync(path.join(this.rootDir, TOKENS_DIR), { recursive: true });
  }

  addGuideline(relativePath: string, content: string): void {
    this.ensureStructure();
    const normalized = normalizeRelativePath(relativePath);
    const absolutePath = path.join(this.rootDir, normalized);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content.trimEnd() + "\n", "utf8");
  }

  readGuideline(relativePath: string): string | null {
    const absolutePath = path.join(this.rootDir, normalizeRelativePath(relativePath));
    if (!fs.existsSync(absolutePath)) {
      return null;
    }

    return fs.readFileSync(absolutePath, "utf8");
  }

  listDocuments(): GuidelineDocument[] {
    this.ensureStructure();
    const relativePaths = walkMarkdownFiles(this.rootDir);
    return relativePaths.map((relativePath) => this.toDocument(relativePath));
  }

  getRoutingDocument(): GuidelineDocument {
    return this.toDocument(GUIDELINES_FILE);
  }

  getOverviewDocuments(): GuidelineDocument[] {
    return [OVERVIEW_COMPONENTS_FILE, OVERVIEW_TOKENS_FILE]
      .map((relativePath) => this.tryDocument(relativePath))
      .filter((document): document is GuidelineDocument => Boolean(document));
  }

  getComponentList(): string[] {
    return this.listDocuments()
      .filter((document) => document.kind === "component")
      .map((document) => document.title)
      .sort((left, right) => left.localeCompare(right));
  }

  getTokenSummaryLines(limit = 12): string[] {
    return this.listDocuments()
      .filter((document) => document.kind === "token")
      .flatMap((document) => extractBulletSummary(document.content))
      .slice(0, limit);
  }

  private tryDocument(relativePath: string): GuidelineDocument | null {
    const absolutePath = path.join(this.rootDir, normalizeRelativePath(relativePath));
    if (!fs.existsSync(absolutePath)) {
      return null;
    }
    return this.toDocument(relativePath);
  }

  private toDocument(relativePath: string): GuidelineDocument {
    const normalized = normalizeRelativePath(relativePath);
    const absolutePath = path.join(this.rootDir, normalized);
    const content = fs.existsSync(absolutePath) ? fs.readFileSync(absolutePath, "utf8") : "";
    const title = extractTitleFromMarkdown(content) ?? titleFromPath(normalized);
    return {
      relativePath: normalized,
      absolutePath,
      title,
      content,
      kind: classifyGuideline(normalized),
      keywords: unique([
        ...tokenize(normalized),
        ...tokenize(title),
        ...tokenize(extractHeadings(content).join(" ")),
      ]),
      tokenEstimate: estimateTokens(content),
    };
  }
}

export class GuidelineRouter {
  private readonly store: GuidelineStore;
  private readonly tokenBudget: number;
  private readonly embeddingProvider: EmbeddingProvider;
  private lastUsage: TokenBudgetUsage;

  constructor(store: GuidelineStore, options: GuidelineRouterOptions = {}) {
    this.store = store;
    this.tokenBudget = options.tokenBudget ?? DEFAULT_GUIDELINE_BUDGET;
    this.embeddingProvider = options.embeddingProvider ?? new LocalHashEmbeddingProvider();
    this.lastUsage = { used: 0, budget: this.tokenBudget };
  }

  async loadForPrompt(userPrompt: string): Promise<string> {
    const routingDoc = this.store.getRoutingDocument();
    const overviewDocs = this.store.getOverviewDocuments();
    const allDocs = this.store.listDocuments();
    const promptKeywords = extractPromptKeywords(userPrompt);
    const promptEmbedding = await this.embeddingProvider.embed(userPrompt);

    const ranked = await Promise.all(
      allDocs
        .filter((document) => document.relativePath !== routingDoc.relativePath)
        .map(async (document) => {
          const keywordScore = scoreKeywords(promptKeywords, document.keywords, document.relativePath);
          const embeddingScore = cosineSimilarity(
            promptEmbedding,
            await this.embeddingProvider.embed(document.title + "\n" + document.content.slice(0, 1600)),
          );
          const priority = basePriorityForDocument(document);
          return {
            ...document,
            priority,
            keywordScore,
            embeddingScore,
            totalScore: priority + keywordScore * 3 + embeddingScore * 8,
          } satisfies RankedGuideline;
        }),
    );

    const selected: GuidelineDocument[] = [];
    let used = 0;

    const pushIfFits = (document: GuidelineDocument): void => {
      if (selected.some((candidate) => candidate.relativePath === document.relativePath)) {
        return;
      }

      if (selected.length === 0 || used + document.tokenEstimate <= this.tokenBudget) {
        selected.push(document);
        used += document.tokenEstimate;
      }
    };

    pushIfFits(routingDoc);

    const overviewPriority = prioritizeOverviewDocs(overviewDocs, promptKeywords, ranked);
    for (const overviewDoc of overviewPriority) {
      pushIfFits(overviewDoc);
    }

    for (const document of ranked.sort(compareRankedGuidelines)) {
      const hasExplicitMatch = document.keywordScore > 0;
      const hasSemanticMatch = document.embeddingScore >= 0.22;
      if (document.totalScore <= 0 || (!hasExplicitMatch && !hasSemanticMatch)) {
        continue;
      }
      pushIfFits(document);
    }

    this.lastUsage = {
      used,
      budget: this.tokenBudget,
    };

    return selected
      .map((document) =>
        [`<!-- ${document.relativePath} -->`, document.content.trim()].filter(Boolean).join("\n"),
      )
      .join("\n\n");
  }

  getTokenBudgetUsage(): { used: number; budget: number } {
    return { ...this.lastUsage };
  }

  async buildSystemPrompt(userPrompt: string): Promise<string> {
    const loadedGuidelines = await this.loadForPrompt(userPrompt);
    return buildGuidelineSystemPrompt({
      loadedGuidelines,
      componentList: this.store.getComponentList(),
      tokenSummary: this.store.getTokenSummaryLines(),
    });
  }
}

export class GuidelineGenerator {
  private readonly store: GuidelineStore;
  private readonly fetchImpl: typeof fetch;

  constructor(store: GuidelineStore, fetchImpl: typeof fetch = fetch) {
    this.store = store;
    this.fetchImpl = fetchImpl;
  }

  async generateFromFigmaLibrary(fileKey: string, figmaToken: string): Promise<void> {
    const { file, localVariables } = await this.fetchFigmaLibrary(fileKey, figmaToken);
    const componentSets = collectNodes(file.document, (node): node is ComponentSetNode => node.type === "COMPONENT_SET");
    const standaloneComponents = collectNodes(
      file.document,
      (node): node is ComponentNode => node.type === "COMPONENT" && !isInsideComponentSet(file.document, node.id),
    );

    const componentDocs: ComponentDocEntry[] = [];

    for (const componentSet of componentSets) {
      const relativePath = path.posix.join(COMPONENTS_DIR, `${slugify(componentSet.name)}.md`);
      const content = this.buildComponentSetGuideline(file, componentSet, localVariables);
      this.store.addGuideline(relativePath, content);
      componentDocs.push({
        relativePath,
        name: componentSet.name,
        description: file.componentSets[componentSet.id]?.description ?? "",
        variants: componentSet.children.map((child) => child.name),
        properties: Object.keys(componentSet.componentPropertyDefinitions ?? {}),
      });
    }

    for (const component of standaloneComponents) {
      const relativePath = path.posix.join(COMPONENTS_DIR, `${slugify(component.name)}.md`);
      const content = this.buildStandaloneComponentGuideline(file, component, localVariables);
      this.store.addGuideline(relativePath, content);
      componentDocs.push({
        relativePath,
        name: component.name,
        description: file.components[component.id]?.description ?? "",
        variants: [component.name],
        properties: Object.keys(component.componentPropertyDefinitions ?? {}),
      });
    }

    this.store.addGuideline(
      OVERVIEW_COMPONENTS_FILE,
      buildComponentsOverviewMarkdown(componentDocs),
    );

    const tokenEntries = buildTokenSummaryEntries(localVariables);
    const categorized = groupTokensByCategory(tokenEntries);
    for (const tokenFile of TOKEN_FILES) {
      const category = tokenFile.replace(".md", "") as TokenCategory;
      this.store.addGuideline(
        path.posix.join(TOKENS_DIR, tokenFile),
        buildTokenCategoryMarkdown(category, categorized[category]),
      );
    }

    this.store.addGuideline(OVERVIEW_TOKENS_FILE, buildTokenOverviewMarkdown(tokenEntries));
    this.store.addGuideline(
      GUIDELINES_FILE,
      buildRoutingGuidelinesMarkdown({
        fileName: file.name,
        componentDocs,
        tokenEntries,
      }),
    );
  }

  private async fetchFigmaLibrary(
    fileKey: string,
    figmaToken: string,
  ): Promise<FigmaLibraryResponses> {
    const headers = {
      "X-Figma-Token": figmaToken,
    };

    const fileResponse = await this.fetchImpl(`https://api.figma.com/v1/files/${fileKey}`, {
      headers,
    });
    if (!fileResponse.ok) {
      throw new Error(`Failed to fetch Figma file ${fileKey}: ${fileResponse.status} ${fileResponse.statusText}`);
    }

    const file = (await fileResponse.json()) as GetFileResponse;

    const variablesResponse = await this.fetchImpl(
      `https://api.figma.com/v1/files/${fileKey}/variables/local`,
      { headers },
    );
    const localVariables = variablesResponse.ok
      ? ((await variablesResponse.json()) as GetLocalVariablesResponse)
      : null;

    return { file, localVariables };
  }

  private buildComponentSetGuideline(
    file: GetFileResponse,
    componentSet: ComponentSetNode,
    localVariables: GetLocalVariablesResponse | null,
  ): string {
    const componentSetMeta = file.componentSets[componentSet.id];
    const semantic = serializeFigmaDesignContext(file as FileResponse, componentSet.id, {
      localVariables,
    }).semantic;

    const rows = componentSet.children
      .map((variant) => {
        const meta = file.components[variant.id];
        return `| ${variant.name} | ${variant.id} | ${meta?.description || "No description"} | ${inferFrequencySuggestion(variant.name, componentSet.children.length)} |`;
      })
      .join("\n");

    const properties = componentPropertyDefinitionsToMarkdown(componentSet.componentPropertyDefinitions ?? {});

    return [
      `# ${componentSet.name}`,
      "",
      componentSetMeta?.description || "Component set generated from the Figma library.",
      "",
      "## Variants",
      "",
      "| Variant | Node ID | Description | Frequency suggestion |",
      "| --- | --- | --- | --- |",
      rows || "| Default | - | No variants found | Low |",
      "",
      "## Properties",
      "",
      properties,
      "",
      "## Semantic snapshot",
      "",
      "```jsx",
      truncateForMarkdown(semantic, 2400),
      "```",
    ].join("\n");
  }

  private buildStandaloneComponentGuideline(
    file: GetFileResponse,
    component: ComponentNode,
    localVariables: GetLocalVariablesResponse | null,
  ): string {
    const componentMeta = file.components[component.id];
    const semantic = serializeFigmaDesignContext(file as FileResponse, component.id, {
      localVariables,
    }).semantic;

    return [
      `# ${component.name}`,
      "",
      componentMeta?.description || "Standalone component generated from the Figma library.",
      "",
      "## Default usage",
      "",
      `- Frequency suggestion: ${inferFrequencySuggestion(component.name, 1)}`,
      `- Node ID: ${component.id}`,
      "",
      "## Properties",
      "",
      componentPropertyDefinitionsToMarkdown(component.componentPropertyDefinitions ?? {}),
      "",
      "## Semantic snapshot",
      "",
      "```jsx",
      truncateForMarkdown(semantic, 2200),
      "```",
    ].join("\n");
  }
}

export class LocalHashEmbeddingProvider implements EmbeddingProvider {
  private readonly dimensions: number;

  constructor(dimensions = 128) {
    this.dimensions = dimensions;
  }

  async embed(text: string): Promise<number[]> {
    const vector = new Array<number>(this.dimensions).fill(0);
    for (const token of tokenize(text)) {
      const hash = createHash("sha256").update(token).digest();
      const index = hash[0] % this.dimensions;
      const sign = hash[1] % 2 === 0 ? 1 : -1;
      vector[index] += sign * (1 + token.length / 12);
    }

    return normalizeVector(vector);
  }
}

export function buildGuidelineSystemPrompt(input: {
  loadedGuidelines: string;
  componentList: string[];
  tokenSummary: string[];
}): string {
  return [
    "You are a design system-aware code generator. Before writing any code, read the following design system guidelines and follow them strictly. Rules prefixed with 'IMPORTANT:' must never be violated.",
    "",
    input.loadedGuidelines.trim(),
    "",
    `Available components: ${input.componentList.join(", ") || "None documented yet"}`,
    `Available tokens: ${input.tokenSummary.join("; ") || "None documented yet"}`,
  ].join("\n");
}

function walkMarkdownFiles(rootDir: string, currentDir = rootDir, output: string[] = []): string[] {
  for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) {
      continue;
    }

    const absolutePath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      walkMarkdownFiles(rootDir, absolutePath, output);
      continue;
    }

    if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      output.push(path.posix.normalize(path.relative(rootDir, absolutePath).split(path.sep).join("/")));
    }
  }

  return output.sort((left, right) => left.localeCompare(right));
}

function normalizeRelativePath(relativePath: string): string {
  return path.posix.normalize(relativePath).replace(/^(\.\.\/)+/, "").replace(/^\/+/, "");
}

function classifyGuideline(relativePath: string): GuidelineKind {
  if (relativePath === GUIDELINES_FILE) {
    return "routing";
  }
  if (relativePath === OVERVIEW_COMPONENTS_FILE || relativePath === OVERVIEW_TOKENS_FILE) {
    return "overview";
  }
  if (relativePath.startsWith(`${COMPONENTS_DIR}/`)) {
    return "component";
  }
  if (relativePath.startsWith(`${TOKENS_DIR}/`)) {
    return "token";
  }
  return "misc";
}

function extractTitleFromMarkdown(content: string): string | null {
  const match = content.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim() ?? null;
}

function extractHeadings(content: string): string[] {
  return Array.from(content.matchAll(/^#{1,3}\s+(.+)$/gm)).map((match) => match[1].trim());
}

function titleFromPath(relativePath: string): string {
  return relativePath
    .replace(/\.md$/i, "")
    .split("/")
    .pop()
    ?.replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase()) ?? relativePath;
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9/ -]+/g, " ")
    .split(/[\s/.-]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function estimateTokens(value: string): number {
  if (!value) {
    return 0;
  }
  return Math.ceil(value.length / 4);
}

function extractPromptKeywords(userPrompt: string): string[] {
  const tokens = tokenize(userPrompt);
  const patternMatches = PATTERN_KEYWORDS.filter((keyword) => userPrompt.toLowerCase().includes(keyword));
  return unique([...tokens, ...patternMatches]);
}

function scoreKeywords(promptKeywords: string[], documentKeywords: string[], relativePath: string): number {
  if (promptKeywords.length === 0) {
    return 0;
  }

  let score = 0;
  const keywordSet = new Set(documentKeywords);
  for (const keyword of promptKeywords) {
    if (keywordSet.has(keyword)) {
      score += 1;
    }
    if (relativePath.includes(keyword)) {
      score += 0.75;
    }
  }

  return score;
}

function cosineSimilarity(left: number[], right: number[]): number {
  const length = Math.max(left.length, right.length);
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }

  if (leftMagnitude === 0 || rightMagnitude === 0) {
    return 0;
  }

  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

function normalizeVector(vector: number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (magnitude === 0) {
    return vector;
  }

  return vector.map((value) => value / magnitude);
}

function basePriorityForDocument(document: GuidelineDocument): number {
  switch (document.kind) {
    case "overview":
      return 7;
    case "component":
      return 5;
    case "token":
      return 4;
    case "routing":
      return 100;
    case "misc":
    default:
      return 1;
  }
}

function prioritizeOverviewDocs(
  overviewDocs: GuidelineDocument[],
  promptKeywords: string[],
  ranked: RankedGuideline[],
): GuidelineDocument[] {
  const hasComponentIntent = promptKeywords.some((keyword) =>
    ["component", "button", "card", "modal", "form", "nav", "header", "footer"].includes(keyword),
  );
  const hasTokenIntent = promptKeywords.some((keyword) =>
    ["color", "colors", "spacing", "typography", "font", "token", "tokens", "radius", "shadow"].includes(keyword),
  );
  const selectedComponentDocs = ranked.some(
    (document) => document.kind === "component" && document.totalScore > 4,
  );
  const selectedTokenDocs = ranked.some((document) => document.kind === "token" && document.totalScore > 4);

  return overviewDocs
    .filter((document) => {
      if (document.relativePath === OVERVIEW_COMPONENTS_FILE) {
        return hasComponentIntent || selectedComponentDocs;
      }
      if (document.relativePath === OVERVIEW_TOKENS_FILE) {
        return hasTokenIntent || selectedTokenDocs;
      }
      return true;
    })
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function compareRankedGuidelines(left: RankedGuideline, right: RankedGuideline): number {
  if (right.totalScore !== left.totalScore) {
    return right.totalScore - left.totalScore;
  }
  if (right.priority !== left.priority) {
    return right.priority - left.priority;
  }
  return left.relativePath.localeCompare(right.relativePath);
}

function collectNodes<TNode extends Node>(
  root: Node,
  predicate: (node: Node) => node is TNode,
): TNode[] {
  const matches: TNode[] = [];
  walkTree(root, (node) => {
    if (predicate(node)) {
      matches.push(node);
    }
  });
  return matches;
}

function walkTree(node: Node, visitor: (node: Node) => void): void {
  visitor(node);
  if ("children" in node && Array.isArray(node.children)) {
    for (const child of node.children as Array<Node | SubcanvasNode>) {
      walkTree(child as Node, visitor);
    }
  }
}

function isInsideComponentSet(root: Node, targetNodeId: string): boolean {
  let inside = false;

  const visit = (node: Node, inComponentSet: boolean): void => {
    if (node.id === targetNodeId && inComponentSet) {
      inside = true;
      return;
    }
    if ("children" in node && Array.isArray(node.children)) {
      for (const child of node.children as Array<Node | SubcanvasNode>) {
        visit(child as Node, inComponentSet || node.type === "COMPONENT_SET");
      }
    }
  };

  visit(root, false);
  return inside;
}

function componentPropertyDefinitionsToMarkdown(
  definitions: Record<string, ComponentPropertyDefinition>,
): string {
  const entries = Object.entries(definitions);
  if (entries.length === 0) {
    return "- No documented component properties.";
  }

  const rows = entries.map(([name, definition]) => {
    const defaultValue =
      typeof definition.defaultValue === "string" || typeof definition.defaultValue === "boolean"
        ? String(definition.defaultValue)
        : "";
    const variants = definition.variantOptions?.join(", ") || "-";
    return `| ${name} | ${definition.type} | ${defaultValue || "-"} | ${variants} |`;
  });

  return [
    "| Property | Type | Default | Variant options |",
    "| --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

function inferFrequencySuggestion(name: string, variantCount: number): "High" | "Medium" | "Low" {
  const normalized = name.toLowerCase();
  if (
    variantCount >= 4 ||
    /(button|input|field|card|chip|badge|icon|nav|header|footer|link)/.test(normalized)
  ) {
    return "High";
  }
  if (/(modal|dialog|dropdown|table|chart|tabs|accordion|hero|sidebar)/.test(normalized)) {
    return "Medium";
  }
  return "Low";
}

function truncateForMarkdown(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return value.slice(0, maxChars).trimEnd() + "\n{/* …truncated for guideline brevity… */}";
}

function buildComponentsOverviewMarkdown(componentDocs: ComponentDocEntry[]): string {
  return [
    "# Components overview",
    "",
    "Use this file to route into the specific component guideline before editing or generating code.",
    "",
    "| Component | File | Variants | Properties |",
    "| --- | --- | --- | --- |",
    ...componentDocs.map(
      (entry) =>
        `| ${entry.name} | ${entry.relativePath} | ${entry.variants.length || 1} | ${entry.properties.length || 0} |`,
    ),
  ].join("\n");
}

function buildTokenSummaryEntries(
  localVariables: GetLocalVariablesResponse | null,
): TokenSummaryEntry[] {
  if (!localVariables) {
    return [];
  }

  return Object.values(localVariables.meta.variables)
    .map((variable) => ({
      category: categorizeVariable(variable),
      name: variable.name,
      value: resolveVariableForDocs(variable, localVariables),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function categorizeVariable(variable: LocalVariable): TokenCategory {
  const normalized = variable.name.toLowerCase();
  if (variable.resolvedType === "COLOR" || normalized.includes("color/") || normalized.includes("palette")) {
    return "colors";
  }
  if (
    normalized.includes("typography") ||
    normalized.includes("font") ||
    variable.scopes.some((scope) =>
      ["FONT_FAMILY", "FONT_STYLE", "FONT_WEIGHT", "FONT_SIZE", "LINE_HEIGHT", "LETTER_SPACING"].includes(
        scope,
      ),
    )
  ) {
    return "typography";
  }
  if (
    normalized.includes("spacing") ||
    normalized.includes("space/") ||
    variable.scopes.some((scope) => ["GAP", "WIDTH_HEIGHT", "CORNER_RADIUS"].includes(scope))
  ) {
    return "spacing";
  }
  return "misc";
}

function resolveVariableForDocs(
  variable: LocalVariable,
  localVariables: GetLocalVariablesResponse,
): string {
  const collection = localVariables.meta.variableCollections[variable.variableCollectionId];
  const value =
    variable.valuesByMode[collection?.defaultModeId ?? ""] ?? Object.values(variable.valuesByMode)[0];

  if (typeof value === "number") {
    if (variable.scopes.some((scope) => ["FONT_WEIGHT", "OPACITY"].includes(scope))) {
      return String(value);
    }
    return `${stripTrailingZeros(value)}px`;
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "boolean") {
    return String(value);
  }
  if (value && typeof value === "object" && "r" in value && "g" in value && "b" in value) {
    return rgbaToHexForDocs(value.r, value.g, value.b, value.a);
  }
  if (value && typeof value === "object" && "id" in value) {
    return `alias:${String(value.id)}`;
  }
  return "-";
}

function groupTokensByCategory(entries: TokenSummaryEntry[]): Record<TokenCategory, TokenSummaryEntry[]> {
  return {
    colors: entries.filter((entry) => entry.category === "colors"),
    typography: entries.filter((entry) => entry.category === "typography"),
    spacing: entries.filter((entry) => entry.category === "spacing"),
    misc: entries.filter((entry) => entry.category === "misc"),
  };
}

function buildTokenCategoryMarkdown(category: TokenCategory, entries: TokenSummaryEntry[]): string {
  const title = category.charAt(0).toUpperCase() + category.slice(1);
  if (entries.length === 0) {
    return `# ${title}\n\n- No ${category} tokens were generated from the Figma variables response.`;
  }

  return [
    `# ${title}`,
    "",
    "| Token | Value |",
    "| --- | --- |",
    ...entries.map((entry) => `| ${entry.name} | ${entry.value} |`),
  ].join("\n");
}

function buildTokenOverviewMarkdown(entries: TokenSummaryEntry[]): string {
  const grouped = groupTokensByCategory(entries);
  return [
    "# Tokens overview",
    "",
    "Use this file to route into the specific token category guideline before generating or refactoring code.",
    "",
    `- Colors: ${grouped.colors.length}`,
    `- Typography: ${grouped.typography.length}`,
    `- Spacing: ${grouped.spacing.length}`,
    `- Misc: ${grouped.misc.length}`,
    "",
    ...entries.slice(0, 16).map((entry) => `- ${entry.name}: ${entry.value}`),
  ].join("\n");
}

function buildRoutingGuidelinesMarkdown(input: {
  fileName: string;
  componentDocs: ComponentDocEntry[];
  tokenEntries: TokenSummaryEntry[];
}): string {
  const tokenCategories = groupTokensByCategory(input.tokenEntries);
  return [
    "# Guidelines",
    "",
    "IMPORTANT: Always read this routing file first before using any other guideline document.",
    "IMPORTANT: Prefer documented components over inventing new primitives when an existing component matches the request.",
    "IMPORTANT: Prefer documented tokens over hard-coded values for color, typography, spacing, radius, and effects.",
    "IMPORTANT: If a request targets a named component or pattern, load its component guideline before generating code.",
    "",
    `This guideline set was generated from the Figma library "${input.fileName}".`,
    "",
    "## Routing rules",
    "",
    `- Start with ${OVERVIEW_COMPONENTS_FILE} for component discovery.`,
    `- Start with ${OVERVIEW_TOKENS_FILE} for token discovery.`,
    `- Load component docs from ${COMPONENTS_DIR}/ when the prompt references a component, section, or interaction pattern.`,
    `- Load token docs from ${TOKENS_DIR}/ when the prompt references color, typography, spacing, or visual polish.`,
    "",
    "## Available files",
    "",
    ...input.componentDocs.map((entry) => `- ${entry.relativePath} — ${entry.name}`),
    `- ${OVERVIEW_COMPONENTS_FILE} — component index`,
    `- ${OVERVIEW_TOKENS_FILE} — token index`,
    ...Object.entries(tokenCategories).map(
      ([category, entries]) => `- ${TOKENS_DIR}/${category}.md — ${entries.length} tokens`,
    ),
    "",
    "## Prompt routing hints",
    "",
    "- Buttons, CTAs, forms, navigation, cards, and repeated UI patterns should route into component guidelines.",
    "- Theme, palette, contrast, spacing, density, readability, and hierarchy changes should route into token guidelines.",
    "- When both structure and styling are changing, load the relevant overview file plus the specific component and token files.",
  ].join("\n");
}

function extractBulletSummary(content: string): string[] {
  return Array.from(content.matchAll(/^- (.+)$/gm)).map((match) => match[1].trim());
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "untitled";
}

function stripTrailingZeros(value: number): string {
  return value.toFixed(2).replace(/\.?0+$/, "");
}

function rgbaToHexForDocs(r: number, g: number, b: number, a?: number): string {
  const channels = [r, g, b].map((channel) =>
    Math.round(Math.max(0, Math.min(1, channel)) * 255)
      .toString(16)
      .padStart(2, "0"),
  );
  if (typeof a === "number" && a < 1) {
    channels.push(
      Math.round(Math.max(0, Math.min(1, a)) * 255)
        .toString(16)
        .padStart(2, "0"),
    );
  }
  return `#${channels.join("")}`;
}

export function createTempGuidelineRoot(prefix = "mymake-guidelines-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
