import type {
  Effect,
  GetFileResponse,
  GetLocalVariablesResponse,
  LocalVariable,
  LocalVariableCollection,
  Node,
  Paint,
  Rectangle,
  RGBA,
  SubcanvasNode,
  TypeStyle,
  VariableAlias,
} from "@figma/rest-api-spec/dist/api_types";

type VariableMeta = GetLocalVariablesResponse["meta"];
export type FileResponse = GetFileResponse;

const DEFAULT_MAX_TOKEN_THRESHOLD = 8000;
const INDENT = "  ";

const SPACING_SCALE = new Map<number, string>([
  [0, "0"],
  [1, "0.25"],
  [2, "0.5"],
  [4, "1"],
  [6, "1.5"],
  [8, "2"],
  [10, "2.5"],
  [12, "3"],
  [14, "3.5"],
  [16, "4"],
  [20, "5"],
  [24, "6"],
  [28, "7"],
  [32, "8"],
  [36, "9"],
  [40, "10"],
  [44, "11"],
  [48, "12"],
  [56, "14"],
  [64, "16"],
  [72, "18"],
  [80, "20"],
  [96, "24"],
]);

const TEXT_SIZE_SCALE = new Map<number, string>([
  [12, "xs"],
  [14, "sm"],
  [16, "base"],
  [18, "lg"],
  [20, "xl"],
  [24, "2xl"],
  [30, "3xl"],
  [36, "4xl"],
  [48, "5xl"],
  [60, "6xl"],
  [72, "7xl"],
]);

const PX_VARIABLE_SCOPES = new Set([
  "CORNER_RADIUS",
  "WIDTH_HEIGHT",
  "GAP",
  "STROKE_FLOAT",
  "EFFECT_FLOAT",
  "FONT_SIZE",
  "LINE_HEIGHT",
  "LETTER_SPACING",
  "PARAGRAPH_SPACING",
  "PARAGRAPH_INDENT",
]);

const PLAIN_NUMBER_SCOPES = new Set(["OPACITY", "FONT_WEIGHT"]);

export interface SerializeFigmaDesignContextOptions {
  localVariables?: GetLocalVariablesResponse | VariableMeta | null;
  maxTokenThreshold?: number;
}

export interface FigmaDesignContextSerialized {
  sparse: string;
  semantic: string;
  variables: Record<string, string>;
  tokenEstimate: number;
  tokenEstimates: {
    sparse: number;
    semantic: number;
    variables: number;
    max: number;
  };
  warnings: string[];
}

interface SerializerContext {
  file: FileResponse;
  variablesMeta: VariableMeta | null;
}

interface VariableReference {
  label: string;
  aliasId: string;
}

type TreeNode = Node | SubcanvasNode;

export function serializeFigmaDesignContext(
  file: FileResponse,
  targetNodeId: string,
  options: SerializeFigmaDesignContextOptions = {},
): FigmaDesignContextSerialized {
  const variablesMeta = normalizeVariablesMeta(options.localVariables);
  const threshold = options.maxTokenThreshold ?? DEFAULT_MAX_TOKEN_THRESHOLD;
  const ctx: SerializerContext = { file, variablesMeta };

  const targetNode = findNodeById(file.document, targetNodeId);
  if (!targetNode) {
    throw new Error(`Figma node "${targetNodeId}" was not found in the file response.`);
  }

  if (!isNodeVisible(targetNode)) {
    const emptyVariables: Record<string, string> = {};
    const warnings = [
      `Target node "${targetNodeId}" is invisible, so all serializer outputs are empty.`,
    ];

    return {
      sparse: "",
      semantic: "",
      variables: emptyVariables,
      tokenEstimate: 0,
      tokenEstimates: {
        sparse: 0,
        semantic: 0,
        variables: 0,
        max: 0,
      },
      warnings,
    };
  }

  const sparse = serializeSparseNode(targetNode, 0).trim();
  const semantic = serializeSemanticNode(targetNode, ctx, 0).trim();
  const variables = serializeVariables(targetNode, ctx);

  const variableJson = JSON.stringify(variables, null, 2);
  const tokenEstimates = {
    sparse: estimateTokenCount(sparse),
    semantic: estimateTokenCount(semantic),
    variables: estimateTokenCount(variableJson),
    max: 0,
  };
  tokenEstimates.max = Math.max(
    tokenEstimates.sparse,
    tokenEstimates.semantic,
    tokenEstimates.variables,
  );

  const warnings: string[] = [];
  if (!ctx.variablesMeta && Object.keys(variables).some((key) => key.startsWith("variable:"))) {
    warnings.push(
      "Variable names/values were only partially resolved. Provide GET /v1/files/:key/variables/local data to resolve bound variable IDs into canonical token names.",
    );
  }

  for (const [mode, estimate] of Object.entries(tokenEstimates)) {
    if (mode === "max") {
      continue;
    }
    if (estimate > threshold) {
      warnings.push(
        `${mode} output is estimated at ${estimate} tokens, which exceeds the ${threshold}-token guidance threshold.`,
      );
    }
  }

  return {
    sparse,
    semantic,
    variables,
    tokenEstimate: tokenEstimates.max,
    tokenEstimates,
    warnings,
  };
}

function normalizeVariablesMeta(
  localVariables?: GetLocalVariablesResponse | VariableMeta | null,
): VariableMeta | null {
  if (!localVariables) {
    return null;
  }

  return "meta" in localVariables ? localVariables.meta : localVariables;
}

function findNodeById(node: TreeNode, targetNodeId: string): TreeNode | null {
  if (node.id === targetNodeId) {
    return node;
  }

  const children = getVisibleChildren(node);
  for (const child of children) {
    const found = findNodeById(child, targetNodeId);
    if (found) {
      return found;
    }
  }

  return null;
}

function getVisibleChildren(node: TreeNode): TreeNode[] {
  if (!("children" in node) || !Array.isArray(node.children)) {
    return [];
  }

  return node.children.filter((child) => isNodeVisible(child as TreeNode)) as TreeNode[];
}

function isNodeVisible(node: TreeNode): boolean {
  if (node.visible === false) {
    return false;
  }

  if ("absoluteBoundingBox" in node && node.absoluteBoundingBox === null) {
    return false;
  }

  return true;
}

function serializeSparseNode(node: TreeNode, depth: number): string {
  const tag = node.type.toUpperCase();
  const bounds = getNodeBounds(node);
  const attributes = [
    `id="${escapeXmlAttribute(node.id)}"`,
    `name="${escapeXmlAttribute(node.name)}"`,
    `x="${formatNumber(bounds?.x ?? 0)}"`,
    `y="${formatNumber(bounds?.y ?? 0)}"`,
    `w="${formatNumber(bounds?.width ?? 0)}"`,
    `h="${formatNumber(bounds?.height ?? 0)}"`,
  ];
  const linePrefix = INDENT.repeat(depth);
  const children = getVisibleChildren(node);

  if (children.length === 0) {
    return `${linePrefix}<${tag} ${attributes.join(" ")}/>`;
  }

  const renderedChildren = children
    .map((child) => serializeSparseNode(child, depth + 1))
    .filter(Boolean)
    .join("\n");

  return `${linePrefix}<${tag} ${attributes.join(" ")}>\n${renderedChildren}\n${linePrefix}</${tag}>`;
}

function serializeSemanticNode(node: TreeNode, ctx: SerializerContext, depth: number): string {
  const comments = buildSemanticComments(node, ctx);
  const tag = getSemanticTag(node);
  const classes = buildSemanticClasses(node, ctx);
  const attrs: string[] = [];
  if (classes.length > 0) {
    attrs.push(`className="${classes.join(" ")}"`);
  }

  if (tag === "img") {
    attrs.push(`alt="${escapeJsxAttribute(node.name || "Image")}"`);
  }

  const linePrefix = INDENT.repeat(depth);
  const openTag = attrs.length > 0 ? `<${tag} ${attrs.join(" ")}>` : `<${tag}>`;
  const closeTag = `</${tag}>`;
  const children = getVisibleChildren(node);
  const textContent = getNodeTextContent(node);
  const parts: string[] = [];

  for (const comment of comments) {
    parts.push(`${linePrefix}{/* ${comment} */}`);
  }

  if (tag === "img") {
    parts.push(
      `${linePrefix}${attrs.length > 0 ? `<${tag} ${attrs.join(" ")}/>` : `<${tag}/>`}`,
    );
    return parts.join("\n");
  }

  if (children.length === 0 && !textContent) {
    parts.push(
      `${linePrefix}${attrs.length > 0 ? `<${tag} ${attrs.join(" ")}/>` : `<${tag}/>`}`,
    );
    return parts.join("\n");
  }

  parts.push(`${linePrefix}${openTag}`);

  if (textContent) {
    parts.push(`${INDENT.repeat(depth + 1)}${escapeJsxText(textContent)}`);
  }

  for (const child of children) {
    parts.push(serializeSemanticNode(child, ctx, depth + 1));
  }

  parts.push(`${linePrefix}${closeTag}`);
  return parts.join("\n");
}

function buildSemanticComments(node: TreeNode, ctx: SerializerContext): string[] {
  const comments: string[] = [];
  const nodeLabel = `${node.type.toLowerCase()}:${node.name || node.id}`;
  comments.push(`node ${nodeLabel} (${node.id})`);

  const componentComment = getComponentComment(node, ctx);
  if (componentComment) {
    comments.push(componentComment);
  }

  const directRefs = collectDirectVariableReferences(node);
  if (directRefs.length > 0) {
    comments.push(
      `tokens ${directRefs
        .map((ref) => `${ref.label}=${resolveVariableLabel(ref.aliasId, ctx)}`)
        .join(", ")}`,
    );
  }

  return comments;
}

function getComponentComment(node: TreeNode, ctx: SerializerContext): string | null {
  if (node.type === "COMPONENT" || node.type === "COMPONENT_SET") {
    const definitions = node.componentPropertyDefinitions
      ? Object.entries(node.componentPropertyDefinitions)
          .map(([name, definition]) => `${name}:${definition.type}`)
          .join(", ")
      : "";

    return definitions
      ? `component ${node.name} | props ${definitions}`
      : `component ${node.name}`;
  }

  if (node.type === "INSTANCE") {
    const componentName = ctx.file.components[node.componentId]?.name ?? node.name;
    const propertyValues = node.componentProperties
      ? Object.entries(node.componentProperties)
          .map(([name, property]) => `${name}=${String(property.value)}`)
          .join(", ")
      : "";
    const overrides = node.overrides
      .flatMap((override) => override.overriddenFields)
      .filter(Boolean)
      .join(", ");

    const segments = [`instanceOf ${componentName}`];
    if (propertyValues) {
      segments.push(`props ${propertyValues}`);
    }
    if (overrides) {
      segments.push(`overrides ${overrides}`);
    }
    return segments.join(" | ");
  }

  return null;
}

function buildSemanticClasses(node: TreeNode, ctx: SerializerContext): string[] {
  const classes: string[] = [];
  const layoutClasses = getLayoutClasses(node);
  const spacingClasses = getSpacingClasses(node);
  const sizeClasses = getSizingClasses(node);
  const appearanceClasses = getAppearanceClasses(node, ctx);
  const textClasses = getTextClasses(node, ctx);
  const positionClasses = getPositionClasses(node);

  classes.push(...layoutClasses, ...spacingClasses, ...sizeClasses, ...appearanceClasses, ...textClasses, ...positionClasses);

  return unique(classes);
}

function getSemanticTag(node: TreeNode): string {
  if (node.type === "TEXT") {
    const size = node.style.fontSize ?? 16;
    const weight = node.style.fontWeight ?? 400;
    if (size >= 40 || (size >= 32 && weight >= 700)) {
      return "h1";
    }
    if (size >= 30) {
      return "h2";
    }
    if (size >= 24) {
      return "h3";
    }
    if (size >= 20) {
      return "h4";
    }
    if (size <= 14 && node.characters.trim().length <= 24) {
      return "span";
    }
    return "p";
  }

  if (node.type === "SECTION") {
    return "section";
  }

  if (isImageLikeNode(node)) {
    return "img";
  }

  return "div";
}

function getLayoutClasses(node: TreeNode): string[] {
  const classes: string[] = [];

  if (!("layoutMode" in node)) {
    return classes;
  }

  switch (node.layoutMode) {
    case "HORIZONTAL":
      classes.push("flex", "flex-row");
      if (node.layoutWrap === "WRAP") {
        classes.push("flex-wrap");
      }
      break;
    case "VERTICAL":
      classes.push("flex", "flex-col");
      if (node.layoutWrap === "WRAP") {
        classes.push("flex-wrap");
      }
      break;
    case "GRID":
      classes.push("grid");
      if (node.gridColumnCount) {
        classes.push(classFromCount("grid-cols", node.gridColumnCount));
      }
      if (node.gridRowCount) {
        classes.push(classFromCount("grid-rows", node.gridRowCount));
      }
      if (typeof node.gridColumnGap === "number") {
        classes.push(classFromSpacing("gap-x", node.gridColumnGap));
      }
      if (typeof node.gridRowGap === "number") {
        classes.push(classFromSpacing("gap-y", node.gridRowGap));
      }
      break;
    default:
      break;
  }

  if (node.primaryAxisAlignItems) {
    classes.push(mapPrimaryAlignment(node.primaryAxisAlignItems));
  }

  if (node.counterAxisAlignItems) {
    classes.push(mapCounterAlignment(node.counterAxisAlignItems));
  }

  if (node.layoutAlign) {
    classes.push(mapSelfAlignment(node.layoutAlign));
  }

  if (node.layoutGrow === 1) {
    classes.push("grow");
  }

  if (node.gridColumnSpan && node.gridColumnSpan > 1) {
    classes.push(classFromCount("col-span", node.gridColumnSpan));
  }

  if (node.gridRowSpan && node.gridRowSpan > 1) {
    classes.push(classFromCount("row-span", node.gridRowSpan));
  }

  return classes;
}

function getSpacingClasses(node: TreeNode): string[] {
  const classes: string[] = [];

  if (!("paddingLeft" in node)) {
    return classes;
  }

  if (typeof node.itemSpacing === "number") {
    classes.push(classFromSpacing("gap", node.itemSpacing));
  }

  const padding = {
    top: node.paddingTop ?? 0,
    right: node.paddingRight ?? 0,
    bottom: node.paddingBottom ?? 0,
    left: node.paddingLeft ?? 0,
  };

  if (padding.top || padding.right || padding.bottom || padding.left) {
    const allEqual =
      padding.top === padding.right &&
      padding.right === padding.bottom &&
      padding.bottom === padding.left;
    const verticalEqual = padding.top === padding.bottom;
    const horizontalEqual = padding.left === padding.right;

    if (allEqual) {
      classes.push(classFromSpacing("p", padding.top));
    } else if (verticalEqual && horizontalEqual) {
      classes.push(classFromSpacing("py", padding.top));
      classes.push(classFromSpacing("px", padding.left));
    } else {
      if (padding.top) {
        classes.push(classFromSpacing("pt", padding.top));
      }
      if (padding.right) {
        classes.push(classFromSpacing("pr", padding.right));
      }
      if (padding.bottom) {
        classes.push(classFromSpacing("pb", padding.bottom));
      }
      if (padding.left) {
        classes.push(classFromSpacing("pl", padding.left));
      }
    }
  }

  return classes;
}

function getSizingClasses(node: TreeNode): string[] {
  const classes: string[] = [];
  const bounds = getNodeBounds(node);

  if ("layoutSizingHorizontal" in node) {
    classes.push(mapSizing(node.layoutSizingHorizontal, "w", bounds?.width));
  } else if (bounds?.width) {
    classes.push(`w-[${formatNumber(bounds.width)}px]`);
  }

  if ("layoutSizingVertical" in node) {
    classes.push(mapSizing(node.layoutSizingVertical, "h", bounds?.height));
  } else if (bounds?.height && node.type !== "TEXT") {
    classes.push(`h-[${formatNumber(bounds.height)}px]`);
  }

  if ("minWidth" in node && typeof node.minWidth === "number") {
    classes.push(`min-w-[${formatNumber(node.minWidth)}px]`);
  }
  if ("maxWidth" in node && typeof node.maxWidth === "number") {
    classes.push(`max-w-[${formatNumber(node.maxWidth)}px]`);
  }
  if ("minHeight" in node && typeof node.minHeight === "number") {
    classes.push(`min-h-[${formatNumber(node.minHeight)}px]`);
  }
  if ("maxHeight" in node && typeof node.maxHeight === "number") {
    classes.push(`max-h-[${formatNumber(node.maxHeight)}px]`);
  }

  return classes.filter(Boolean);
}

function getAppearanceClasses(node: TreeNode, ctx: SerializerContext): string[] {
  const classes: string[] = [];

  const fillClasses = getFillClasses(node, ctx);
  classes.push(...fillClasses);

  const strokeClasses = getStrokeClasses(node, ctx);
  classes.push(...strokeClasses);

  if ("cornerRadius" in node || "rectangleCornerRadii" in node) {
    const radius = getPrimaryCornerRadius(node);
    if (typeof radius === "number" && radius > 0) {
      classes.push(classFromRadius(radius));
    }
  }

  if ("effects" in node && Array.isArray(node.effects) && node.effects.length > 0) {
    const shadowClass = classFromEffects(node.effects);
    if (shadowClass) {
      classes.push(shadowClass);
    }
  }

  if ("opacity" in node && typeof node.opacity === "number" && node.opacity < 1) {
    classes.push(`opacity-[${formatNumber(node.opacity * 100)}%]`);
  }

  if ("clipsContent" in node && node.clipsContent) {
    classes.push("overflow-hidden");
  }

  return classes;
}

function getTextClasses(node: TreeNode, ctx: SerializerContext): string[] {
  const classes: string[] = [];
  const textStyle = getNodeTextStyle(node);

  if (!textStyle) {
    return classes;
  }

  if (typeof textStyle.fontSize === "number") {
    classes.push(classFromTextSize(textStyle.fontSize));
  }

  if (typeof textStyle.fontWeight === "number") {
    classes.push(classFromFontWeight(textStyle.fontWeight));
  }

  if (typeof textStyle.lineHeightPx === "number") {
    classes.push(`leading-[${formatNumber(textStyle.lineHeightPx)}px]`);
  }

  if (typeof textStyle.letterSpacing === "number" && textStyle.letterSpacing !== 0) {
    classes.push(`tracking-[${formatNumber(textStyle.letterSpacing)}px]`);
  }

  if (textStyle.textAlignHorizontal) {
    classes.push(mapTextAlignment(textStyle.textAlignHorizontal));
  }

  if (textStyle.textCase && textStyle.textCase !== "ORIGINAL") {
    classes.push(mapTextCase(textStyle.textCase));
  }

  const textFill = getFirstVisiblePaint(textStyle.fills);
  if (textFill) {
    const textColorClass = paintToClass(textFill, "text", ctx);
    if (textColorClass) {
      classes.push(textColorClass);
    }
  }

  return classes;
}

function getPositionClasses(node: TreeNode): string[] {
  const classes: string[] = [];
  if (!("layoutPositioning" in node)) {
    return classes;
  }

  if (node.layoutPositioning === "ABSOLUTE") {
    const bounds = getNodeBounds(node);
    classes.push("absolute");
    if (bounds) {
      classes.push(`left-[${formatNumber(bounds.x)}px]`);
      classes.push(`top-[${formatNumber(bounds.y)}px]`);
    }
  }

  return classes;
}

function getFillClasses(node: TreeNode, ctx: SerializerContext): string[] {
  const classes: string[] = [];

  if (!("fills" in node)) {
    return classes;
  }

  const fill = getFirstVisiblePaint(node.fills);
  if (!fill) {
    return classes;
  }

  const prefix = node.type === "TEXT" ? "text" : "bg";
  const fillClass = paintToClass(fill, prefix, ctx);
  if (fillClass) {
    classes.push(fillClass);
  }

  if (fill.type === "IMAGE") {
    classes.push("bg-cover", "bg-center");
  }

  return classes;
}

function getStrokeClasses(node: TreeNode, ctx: SerializerContext): string[] {
  if (!("strokes" in node) || !node.strokes) {
    return [];
  }

  const stroke = getFirstVisiblePaint(node.strokes);
  if (!stroke) {
    return [];
  }

  const borderColorClass = paintToClass(stroke, "border", ctx);
  return borderColorClass ? ["border", borderColorClass] : ["border"];
}

function getNodeTextStyle(node: TreeNode): TypeStyle | null {
  if (node.type === "TEXT") {
    return node.style;
  }

  return null;
}

function getNodeTextContent(node: TreeNode): string {
  if ("characters" in node && typeof node.characters === "string") {
    return node.characters.trim();
  }
  return "";
}

function getNodeBounds(node: TreeNode): Rectangle | null {
  if ("absoluteBoundingBox" in node) {
    return node.absoluteBoundingBox;
  }
  return null;
}

function isImageLikeNode(node: TreeNode): boolean {
  if (node.type === "EMBED") {
    return true;
  }

  if (!("fills" in node)) {
    return false;
  }

  return node.fills.some((fill) => fill.visible !== false && fill.type === "IMAGE");
}

function serializeVariables(node: TreeNode, ctx: SerializerContext): Record<string, string> {
  const aliasIds = collectSubtreeAliasIds(node);
  const entries = Array.from(aliasIds)
    .map((aliasId) => resolveVariableEntry(aliasId, ctx))
    .sort(([left], [right]) => left.localeCompare(right));

  return Object.fromEntries(entries);
}

function collectSubtreeAliasIds(node: TreeNode): Set<string> {
  const aliases = new Set<string>();

  walkValues(node, aliases, new WeakSet<object>());
  return aliases;
}

function collectDirectVariableReferences(node: TreeNode): VariableReference[] {
  const sources: Array<[string, unknown]> = [
    ["node", "boundVariables" in node ? node.boundVariables : undefined],
    ["fills", "fills" in node ? node.fills : undefined],
    ["strokes", "strokes" in node ? node.strokes : undefined],
    ["effects", "effects" in node ? node.effects : undefined],
    ["componentProperties", node.type === "INSTANCE" ? node.componentProperties : undefined],
    ["textStyle", node.type === "TEXT" ? node.style : undefined],
    ["styleOverrides", node.type === "TEXT" ? node.styleOverrideTable : undefined],
  ];

  const refs: VariableReference[] = [];
  for (const [label, source] of sources) {
    const aliasIds = new Set<string>();
    walkValues(source, aliasIds, new WeakSet<object>());
    for (const aliasId of aliasIds) {
      refs.push({ label, aliasId });
    }
  }

  return refs.filter(
    (ref, index, array) =>
      array.findIndex((candidate) => candidate.label === ref.label && candidate.aliasId === ref.aliasId) ===
      index,
  );
}

function walkValues(value: unknown, aliasIds: Set<string>, visited: WeakSet<object>): void {
  if (!value || typeof value !== "object") {
    return;
  }

  if (isVariableAlias(value)) {
    aliasIds.add(value.id);
    return;
  }

  if (visited.has(value)) {
    return;
  }

  visited.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      walkValues(item, aliasIds, visited);
    }
    return;
  }

  for (const nestedValue of Object.values(value)) {
    walkValues(nestedValue, aliasIds, visited);
  }
}

function resolveVariableEntry(aliasId: string, ctx: SerializerContext): [string, string] {
  if (!ctx.variablesMeta) {
    return [`variable:${aliasId}`, `alias:${aliasId}`];
  }

  const variable = ctx.variablesMeta.variables[aliasId];
  if (!variable) {
    return [`variable:${aliasId}`, `alias:${aliasId}`];
  }

  return [variable.name, resolveVariableValue(variable, ctx.variablesMeta, new Set())];
}

function resolveVariableLabel(aliasId: string, ctx: SerializerContext): string {
  const [name] = resolveVariableEntry(aliasId, ctx);
  return name;
}

function resolveVariableValue(
  variable: LocalVariable,
  meta: VariableMeta,
  visited: Set<string>,
): string {
  if (visited.has(variable.id)) {
    return `alias:${variable.id}`;
  }

  visited.add(variable.id);

  const collection = meta.variableCollections[variable.variableCollectionId];
  const resolvedRawValue = getVariableValueForDefaultMode(variable, collection);
  const rawValue = isVariableAlias(resolvedRawValue)
    ? resolveAliasValue(resolvedRawValue, meta, visited)
    : resolvedRawValue;

  switch (variable.resolvedType) {
    case "COLOR":
      return isRgba(rawValue) ? rgbaToHex(rawValue) : String(rawValue);
    case "BOOLEAN":
      return String(Boolean(rawValue));
    case "STRING":
      return String(rawValue ?? "");
    case "FLOAT":
      return formatFloatVariableValue(rawValue, variable);
    default:
      return String(rawValue ?? "");
  }
}

function getVariableValueForDefaultMode(
  variable: LocalVariable,
  collection: LocalVariableCollection | undefined,
): boolean | number | string | RGBA | VariableAlias | undefined {
  if (!collection) {
    return Object.values(variable.valuesByMode)[0];
  }

  return (
    variable.valuesByMode[collection.defaultModeId] ??
    variable.valuesByMode[collection.modes[0]?.modeId ?? ""] ??
    Object.values(variable.valuesByMode)[0]
  );
}

function resolveAliasValue(
  alias: VariableAlias,
  meta: VariableMeta,
  visited: Set<string>,
): boolean | number | string | RGBA | VariableAlias | undefined {
  const aliasedVariable = meta.variables[alias.id];
  if (!aliasedVariable) {
    return alias;
  }

  const resolved = resolveVariableValue(aliasedVariable, meta, visited);
  if (aliasedVariable.resolvedType === "COLOR" && isHexColor(resolved)) {
    return hexToRgba(resolved);
  }
  return resolved;
}

function formatFloatVariableValue(
  value: boolean | number | string | RGBA | VariableAlias | undefined,
  variable: LocalVariable,
): string {
  if (typeof value !== "number") {
    return String(value ?? "");
  }

  if (variable.scopes.some((scope) => PLAIN_NUMBER_SCOPES.has(scope))) {
    return formatNumber(value);
  }

  if (variable.scopes.some((scope) => PX_VARIABLE_SCOPES.has(scope))) {
    return `${formatNumber(value)}px`;
  }

  if (value >= 0 && value <= 1) {
    return formatNumber(value);
  }

  if (value > 100 && Number.isInteger(value)) {
    return formatNumber(value);
  }

  return `${formatNumber(value)}px`;
}

function getFirstVisiblePaint(paints?: Paint[]): Paint | null {
  if (!paints) {
    return null;
  }

  return paints.find((paint) => paint.visible !== false) ?? null;
}

function getPaintColorAlias(paint: Paint): VariableAlias | null {
  if (paint.type === "SOLID" && paint.boundVariables?.color) {
    return paint.boundVariables.color;
  }

  return null;
}

function paintToClass(
  paint: Paint,
  prefix: "bg" | "text" | "border",
  ctx: SerializerContext,
): string | null {
  if (paint.type === "SOLID") {
    return `${prefix}-[${rgbaToHex(applyPaintOpacity(paint.color, paint.opacity))}]`;
  }

  if (
    paint.type === "GRADIENT_LINEAR" ||
    paint.type === "GRADIENT_RADIAL" ||
    paint.type === "GRADIENT_ANGULAR" ||
    paint.type === "GRADIENT_DIAMOND"
  ) {
    const first = paint.gradientStops[0];
    const last = paint.gradientStops[paint.gradientStops.length - 1];
    if (first && last) {
      return `${prefix}-gradient-[${rgbaToHex(first.color)}_${rgbaToHex(last.color)}]`;
    }
  }

  if (paint.type === "IMAGE" && prefix === "bg") {
    return "bg-neutral-900";
  }

  const colorAlias = getPaintColorAlias(paint);
  if (colorAlias) {
    const resolvedName = resolveVariableLabel(colorAlias.id, ctx);
    return `${prefix}-[var(--${sanitizeCssVarName(resolvedName)})]`;
  }

  return null;
}

function classFromEffects(effects: Effect[]): string | null {
  const shadow = effects.find(
    (effect) => effect.visible !== false && (effect.type === "DROP_SHADOW" || effect.type === "INNER_SHADOW"),
  );
  if (!shadow) {
    return null;
  }

  const radius = "radius" in shadow ? shadow.radius : 0;
  if (radius <= 4) {
    return "shadow-sm";
  }
  if (radius <= 12) {
    return "shadow-md";
  }
  if (radius <= 24) {
    return "shadow-lg";
  }
  return "shadow-xl";
}

function classFromRadius(radius: number): string {
  if (radius === 9999) {
    return "rounded-full";
  }
  if (radius <= 2) {
    return "rounded-sm";
  }
  if (radius <= 6) {
    return "rounded-md";
  }
  if (radius <= 12) {
    return "rounded-lg";
  }
  if (radius <= 16) {
    return "rounded-xl";
  }
  return `rounded-[${formatNumber(radius)}px]`;
}

function getPrimaryCornerRadius(node: TreeNode): number | undefined {
  if ("cornerRadius" in node && typeof node.cornerRadius === "number") {
    return node.cornerRadius;
  }

  if ("rectangleCornerRadii" in node && Array.isArray(node.rectangleCornerRadii)) {
    return Math.max(...node.rectangleCornerRadii, 0);
  }

  return undefined;
}

function classFromSpacing(prefix: string, value: number): string {
  const mapped = SPACING_SCALE.get(value);
  return mapped ? `${prefix}-${mapped}` : `${prefix}-[${formatNumber(value)}px]`;
}

function classFromTextSize(fontSize: number): string {
  const mapped = TEXT_SIZE_SCALE.get(fontSize);
  return mapped ? `text-${mapped}` : `text-[${formatNumber(fontSize)}px]`;
}

function classFromFontWeight(fontWeight: number): string {
  if (fontWeight >= 800) {
    return "font-extrabold";
  }
  if (fontWeight >= 700) {
    return "font-bold";
  }
  if (fontWeight >= 600) {
    return "font-semibold";
  }
  if (fontWeight >= 500) {
    return "font-medium";
  }
  if (fontWeight >= 400) {
    return "font-normal";
  }
  return `font-[${formatNumber(fontWeight)}]`;
}

function classFromCount(prefix: string, value: number): string {
  if (value >= 1 && value <= 12) {
    return `${prefix}-${value}`;
  }
  return `${prefix}-[${value}]`;
}

function mapPrimaryAlignment(
  value: "MIN" | "CENTER" | "MAX" | "SPACE_BETWEEN",
): string {
  switch (value) {
    case "CENTER":
      return "justify-center";
    case "MAX":
      return "justify-end";
    case "SPACE_BETWEEN":
      return "justify-between";
    case "MIN":
    default:
      return "justify-start";
  }
}

function mapCounterAlignment(
  value: "MIN" | "CENTER" | "MAX" | "BASELINE",
): string {
  switch (value) {
    case "CENTER":
      return "items-center";
    case "MAX":
      return "items-end";
    case "BASELINE":
      return "items-baseline";
    case "MIN":
    default:
      return "items-start";
  }
}

function mapSelfAlignment(value: "INHERIT" | "STRETCH" | "MIN" | "CENTER" | "MAX"): string {
  switch (value) {
    case "STRETCH":
      return "self-stretch";
    case "CENTER":
      return "self-center";
    case "MAX":
      return "self-end";
    case "MIN":
      return "self-start";
    case "INHERIT":
    default:
      return "";
  }
}

function mapSizing(
  value: "FIXED" | "HUG" | "FILL" | undefined,
  axis: "w" | "h",
  fallback?: number,
): string {
  switch (value) {
    case "FILL":
      return `${axis}-full`;
    case "HUG":
      return axis === "w" ? "w-fit" : "h-auto";
    case "FIXED":
      return typeof fallback === "number" ? `${axis}-[${formatNumber(fallback)}px]` : `${axis}-auto`;
    default:
      return typeof fallback === "number" ? `${axis}-[${formatNumber(fallback)}px]` : "";
  }
}

function mapTextAlignment(value: "LEFT" | "RIGHT" | "CENTER" | "JUSTIFIED"): string {
  switch (value) {
    case "RIGHT":
      return "text-right";
    case "CENTER":
      return "text-center";
    case "JUSTIFIED":
      return "text-justify";
    case "LEFT":
    default:
      return "text-left";
  }
}

function mapTextCase(
  value: "ORIGINAL" | "UPPER" | "LOWER" | "TITLE" | "SMALL_CAPS" | "SMALL_CAPS_FORCED",
): string {
  switch (value) {
    case "UPPER":
      return "uppercase";
    case "LOWER":
      return "lowercase";
    case "TITLE":
      return "capitalize";
    case "SMALL_CAPS":
    case "SMALL_CAPS_FORCED":
      return "uppercase tracking-wide";
    case "ORIGINAL":
    default:
      return "";
  }
}

function applyPaintOpacity(color: RGBA, opacity?: number): RGBA {
  if (typeof opacity !== "number") {
    return color;
  }
  return { ...color, a: color.a * opacity };
}

function rgbaToHex(color: RGBA): string {
  const red = channelToHex(color.r);
  const green = channelToHex(color.g);
  const blue = channelToHex(color.b);
  const alpha = channelToHex(color.a);
  return alpha === "ff" ? `#${red}${green}${blue}` : `#${red}${green}${blue}${alpha}`;
}

function hexToRgba(color: string): RGBA {
  const hex = color.replace("#", "");
  const normalized = hex.length === 6 ? `${hex}ff` : hex;
  return {
    r: parseInt(normalized.slice(0, 2), 16) / 255,
    g: parseInt(normalized.slice(2, 4), 16) / 255,
    b: parseInt(normalized.slice(4, 6), 16) / 255,
    a: parseInt(normalized.slice(6, 8), 16) / 255,
  };
}

function channelToHex(channel: number): string {
  return Math.round(Math.max(0, Math.min(1, channel)) * 255)
    .toString(16)
    .padStart(2, "0");
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, "");
}

function estimateTokenCount(value: string): number {
  if (!value) {
    return 0;
  }
  return Math.ceil(value.length / 4);
}

function unique(values: string[]): string[] {
  return values.filter(Boolean).filter((value, index, array) => array.indexOf(value) === index);
}

function isVariableAlias(value: unknown): value is VariableAlias {
  return Boolean(
    value &&
      typeof value === "object" &&
      "type" in value &&
      "id" in value &&
      (value as { type?: string }).type === "VARIABLE_ALIAS" &&
      typeof (value as { id?: string }).id === "string",
  );
}

function isRgba(value: unknown): value is RGBA {
  return Boolean(
    value &&
      typeof value === "object" &&
      "r" in value &&
      "g" in value &&
      "b" in value &&
      "a" in value,
  );
}

function isHexColor(value: string): boolean {
  return /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value);
}

function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeJsxText(value: string): string {
  return value.replaceAll("{", "&#123;").replaceAll("}", "&#125;");
}

function escapeJsxAttribute(value: string): string {
  return value.replaceAll('"', "&quot;");
}

function sanitizeCssVarName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replaceAll("/", "-");
}
