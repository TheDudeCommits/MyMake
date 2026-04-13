import vm from "node:vm";

type NodeType =
  | "FRAME"
  | "TEXT"
  | "INSTANCE"
  | "RECTANGLE"
  | "ELLIPSE"
  | "GROUP"
  | "COMPONENT"
  | "COMPONENT_SET";

type LayoutMode = "NONE" | "HORIZONTAL" | "VERTICAL" | "GRID";
type AutoLayoutSizingMode = "FIXED" | "AUTO";
type ChildLayoutSizingMode = "FIXED" | "HUG" | "FILL";
type TextAutoResize = "NONE" | "WIDTH_AND_HEIGHT" | "HEIGHT";
type ConstraintAxisHorizontal = "LEFT" | "RIGHT" | "CENTER" | "LEFT_RIGHT" | "SCALE";
type ConstraintAxisVertical = "TOP" | "BOTTOM" | "CENTER" | "TOP_BOTTOM" | "SCALE";

export interface DeclarativeConstraints {
  horizontal: ConstraintAxisHorizontal;
  vertical: ConstraintAxisVertical;
}

export interface DeclarativePadding {
  top?: number;
  right?: number;
  bottom?: number;
  left?: number;
}

export interface DeclarativeFillSpec {
  type: "SOLID";
  color?: string;
  opacity?: number;
  variableKey?: string;
}

export interface DeclarativeDesignNode {
  refId?: string;
  type: NodeType;
  name?: string;
  width?: number;
  height?: number;
  layout?: LayoutMode;
  padding?: number | DeclarativePadding;
  gap?: number;
  fills?: DeclarativeFillSpec[];
  color?: string;
  opacity?: number;
  cornerRadius?: number;
  rectangleCornerRadii?: [number, number, number, number];
  primaryAxisSizingMode?: AutoLayoutSizingMode;
  counterAxisSizingMode?: AutoLayoutSizingMode;
  layoutSizingHorizontal?: ChildLayoutSizingMode;
  layoutSizingVertical?: ChildLayoutSizingMode;
  constraints?: DeclarativeConstraints;
  content?: string;
  fontSize?: number;
  fontWeight?: number | string;
  fontFamily?: string;
  fontStyle?: string;
  textAutoResize?: TextAutoResize;
  componentKey?: string;
  overrides?: Record<string, string | boolean | number>;
  children?: DeclarativeDesignNode[];
}

export interface DeclarativeModifyInstruction {
  action: "modify";
  nodeId: string;
  updates: Partial<DeclarativeDesignNode> & { type?: NodeType };
}

export interface DeclarativeCreateInstruction extends DeclarativeDesignNode {
  action?: "create";
}

export interface DeclarativeBatchInstruction {
  action: "batch";
  operations: DeclarativeInstruction[];
}

export type DeclarativeInstruction =
  | DeclarativeCreateInstruction
  | DeclarativeModifyInstruction
  | DeclarativeBatchInstruction;

export type OperationKind =
  | "lookupNode"
  | "createNode"
  | "importComponent"
  | "instantiateComponent"
  | "appendChild"
  | "setName"
  | "setLayoutMode"
  | "setLayoutProperties"
  | "resize"
  | "setSizingModes"
  | "setLayoutSizing"
  | "setConstraints"
  | "setOpacity"
  | "setCornerRadius"
  | "setRectangleCornerRadii"
  | "loadFont"
  | "setFontName"
  | "setFontSize"
  | "setTextFills"
  | "setCharacters"
  | "setTextAutoResize"
  | "setFills"
  | "setInstanceOverrides"
  | "setVariableBinding";

export interface FigmaOperation {
  id: string;
  kind: OperationKind;
  nodeRef?: string;
  payload?: Record<string, unknown>;
  dependsOn: string[];
  meta?: {
    parentRef?: string;
    parentAutoLayout?: boolean;
    affectsText?: boolean;
    affectsLayout?: boolean;
  };
}

export interface OperationBuildResult {
  operations: FigmaOperation[];
  warnings: string[];
}

export interface OperationValidationResult {
  valid: boolean;
  operations: FigmaOperation[];
  errors: string[];
  warnings: string[];
}

export interface CompilationResult {
  code: string;
  validation: OperationValidationResult;
}

export interface ParsedAiResponse {
  instruction: DeclarativeInstruction;
  normalizedJson: string;
}

export class OperationGraph {
  private operations: FigmaOperation[] = [];
  private warnings: string[] = [];
  private sequence = 0;
  private refSequence = 0;
  private knownNodes = new Map<string, { isAutoLayout: boolean }>();

  build(instruction: DeclarativeInstruction): OperationBuildResult {
    this.operations = [];
    this.warnings = [];
    this.sequence = 0;
    this.refSequence = 0;
    this.knownNodes.clear();

    this.walkInstruction(instruction, { parentRef: "currentPage", parentAutoLayout: false });
    return {
      operations: this.sortOperations(this.operations),
      warnings: [...this.warnings],
    };
  }

  sortOperations(operations: FigmaOperation[]): FigmaOperation[] {
    const order = new Map<string, number>();
    operations.forEach((operation, index) => {
      order.set(operation.id, index);
    });

    const indegree = new Map<string, number>();
    const graph = new Map<string, string[]>();

    for (const operation of operations) {
      indegree.set(operation.id, 0);
      graph.set(operation.id, []);
    }

    for (const operation of operations) {
      for (const dependency of operation.dependsOn) {
        if (!graph.has(dependency)) {
          continue;
        }
        graph.get(dependency)?.push(operation.id);
        indegree.set(operation.id, (indegree.get(operation.id) ?? 0) + 1);
      }
    }

    const queue = operations
      .filter((operation) => (indegree.get(operation.id) ?? 0) === 0)
      .sort((left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0));

    const sorted: FigmaOperation[] = [];
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) {
        continue;
      }
      sorted.push(current);
      for (const dependentId of graph.get(current.id) ?? []) {
        const nextDegree = (indegree.get(dependentId) ?? 0) - 1;
        indegree.set(dependentId, nextDegree);
        if (nextDegree === 0) {
          const dependent = operations.find((operation) => operation.id === dependentId);
          if (dependent) {
            queue.push(dependent);
            queue.sort(
              (left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0),
            );
          }
        }
      }
    }

    if (sorted.length !== operations.length) {
      throw new Error("The Figma operation graph contains a cycle.");
    }

    return sorted;
  }

  private walkInstruction(
    instruction: DeclarativeInstruction,
    parentContext: { parentRef: string; parentAutoLayout: boolean },
  ): void {
    if ("action" in instruction && instruction.action === "batch") {
      for (const child of instruction.operations) {
        this.walkInstruction(child, parentContext);
      }
      return;
    }

    if ("action" in instruction && instruction.action === "modify") {
      this.buildModifyInstruction(instruction, parentContext);
      return;
    }

    this.buildCreateInstruction(instruction, parentContext);
  }

  private buildCreateInstruction(
    node: DeclarativeCreateInstruction,
    parentContext: { parentRef: string; parentAutoLayout: boolean },
  ): void {
    const nodeRef = node.refId ?? this.nextRef(node.type.toLowerCase());
    const baseOperationIds: string[] = [];

    if (node.type === "INSTANCE") {
      if (!node.componentKey) {
        throw new Error(`INSTANCE node "${nodeRef}" is missing componentKey.`);
      }
      const importId = this.addOperation({
        kind: "importComponent",
        nodeRef,
        payload: { componentKey: node.componentKey },
      });
      const instantiateId = this.addOperation({
        kind: "instantiateComponent",
        nodeRef,
        dependsOn: [importId],
        payload: { componentKey: node.componentKey },
      });
      baseOperationIds.push(importId, instantiateId);
    } else {
      const createId = this.addOperation({
        kind: "createNode",
        nodeRef,
        payload: { nodeType: node.type },
      });
      baseOperationIds.push(createId);
    }

    const nodeCreatedId = baseOperationIds.at(-1);
    if (!nodeCreatedId) {
      throw new Error(`Unable to build node "${nodeRef}".`);
    }

    const isAutoLayout = node.layout === "VERTICAL" || node.layout === "HORIZONTAL" || node.layout === "GRID";
    this.knownNodes.set(nodeRef, { isAutoLayout });

    if (node.name) {
      this.addOperation({
        kind: "setName",
        nodeRef,
        dependsOn: [nodeCreatedId],
        payload: { name: node.name },
      });
    }

    let layoutModeId: string | null = null;
    if (node.layout && node.layout !== "NONE") {
      layoutModeId = this.addOperation({
        kind: "setLayoutMode",
        nodeRef,
        dependsOn: [nodeCreatedId],
        payload: { layoutMode: node.layout },
        meta: { affectsLayout: true },
      });
    }

    let resizeId: string | null = null;
    if (typeof node.width === "number" || typeof node.height === "number") {
      resizeId = this.addOperation({
        kind: "resize",
        nodeRef,
        dependsOn: [nodeCreatedId],
        payload: {
          width: node.width ?? null,
          height: node.height ?? null,
        },
      });
    }

    if (node.primaryAxisSizingMode || node.counterAxisSizingMode) {
      this.addOperation({
        kind: "setSizingModes",
        nodeRef,
        dependsOn: [resizeId ?? nodeCreatedId],
        payload: {
          primaryAxisSizingMode: node.primaryAxisSizingMode ?? null,
          counterAxisSizingMode: node.counterAxisSizingMode ?? null,
        },
        meta: { affectsLayout: true },
      });
    }

    if (
      layoutModeId &&
      (node.padding !== undefined || node.gap !== undefined)
    ) {
      this.addOperation({
        kind: "setLayoutProperties",
        nodeRef,
        dependsOn: [layoutModeId],
        payload: {
          padding: normalizePadding(node.padding),
          gap: node.gap ?? null,
        },
        meta: { affectsLayout: true },
      });
    }

    const appendId = this.addOperation({
      kind: "appendChild",
      nodeRef,
      dependsOn: [nodeCreatedId],
      payload: { parentRef: parentContext.parentRef },
      meta: {
        parentRef: parentContext.parentRef,
        parentAutoLayout: parentContext.parentAutoLayout,
      },
    });

    if (node.layoutSizingHorizontal || node.layoutSizingVertical) {
      this.addOperation({
        kind: "setLayoutSizing",
        nodeRef,
        dependsOn: [appendId],
        payload: {
          horizontal: node.layoutSizingHorizontal ?? null,
          vertical: node.layoutSizingVertical ?? null,
        },
        meta: {
          parentRef: parentContext.parentRef,
          parentAutoLayout: parentContext.parentAutoLayout,
          affectsLayout: true,
        },
      });
    }

    if (node.constraints) {
      this.addOperation({
        kind: "setConstraints",
        nodeRef,
        dependsOn: [appendId],
        payload: {
          horizontal: node.constraints.horizontal,
          vertical: node.constraints.vertical,
        },
        meta: {
          parentRef: parentContext.parentRef,
          parentAutoLayout: parentContext.parentAutoLayout,
          affectsLayout: true,
        },
      });
    }

    if (typeof node.opacity === "number") {
      this.addOperation({
        kind: "setOpacity",
        nodeRef,
        dependsOn: [nodeCreatedId],
        payload: { opacity: node.opacity },
      });
    }

    if (typeof node.cornerRadius === "number") {
      this.addOperation({
        kind: "setCornerRadius",
        nodeRef,
        dependsOn: [nodeCreatedId],
        payload: { cornerRadius: node.cornerRadius },
      });
    }

    if (node.rectangleCornerRadii) {
      this.addOperation({
        kind: "setRectangleCornerRadii",
        nodeRef,
        dependsOn: [nodeCreatedId],
        payload: { rectangleCornerRadii: [...node.rectangleCornerRadii] },
      });
    }

    const fills = this.resolveNodeFills(node);
    if (fills.length > 0) {
      this.addOperation({
        kind: node.type === "TEXT" ? "setTextFills" : "setFills",
        nodeRef,
        dependsOn: [nodeCreatedId],
        payload: { fills },
      });
    }

    if (this.hasTextMutations(node)) {
      const fontDescriptor = normalizeFontDescriptor(node);
      const loadFontId = this.addOperation({
        kind: "loadFont",
        nodeRef,
        dependsOn: [nodeCreatedId],
        payload: fontDescriptor,
        meta: { affectsText: true },
      });

      if (fontDescriptor.fontFamily || fontDescriptor.fontStyle) {
        this.addOperation({
          kind: "setFontName",
          nodeRef,
          dependsOn: [loadFontId],
          payload: fontDescriptor,
          meta: { affectsText: true },
        });
      }

      if (typeof node.fontSize === "number") {
        this.addOperation({
          kind: "setFontSize",
          nodeRef,
          dependsOn: [loadFontId],
          payload: { fontSize: node.fontSize },
          meta: { affectsText: true },
        });
      }

      let charactersId: string | null = null;
      if (typeof node.content === "string") {
        charactersId = this.addOperation({
          kind: "setCharacters",
          nodeRef,
          dependsOn: [loadFontId],
          payload: { content: node.content },
          meta: { affectsText: true },
        });
      }

      if (node.textAutoResize) {
        this.addOperation({
          kind: "setTextAutoResize",
          nodeRef,
          dependsOn: [charactersId ?? loadFontId],
          payload: { textAutoResize: node.textAutoResize },
          meta: { affectsText: true },
        });
      }
    }

    if (node.type === "INSTANCE" && node.overrides && Object.keys(node.overrides).length > 0) {
      this.addOperation({
        kind: "setInstanceOverrides",
        nodeRef,
        dependsOn: [appendId],
        payload: { overrides: node.overrides },
      });
    }

    for (const child of node.children ?? []) {
      this.walkInstruction(child, {
        parentRef: nodeRef,
        parentAutoLayout: isAutoLayout,
      });
    }
  }

  private buildModifyInstruction(
    instruction: DeclarativeModifyInstruction,
    parentContext: { parentRef: string; parentAutoLayout: boolean },
  ): void {
    const nodeRef = this.nextRef("existing");
    const lookupId = this.addOperation({
      kind: "lookupNode",
      nodeRef,
      payload: { nodeId: instruction.nodeId },
    });

    const normalized: DeclarativeCreateInstruction = {
      ...(instruction.updates as DeclarativeCreateInstruction),
      action: "create",
      refId: nodeRef,
      type: instruction.updates.type ?? "FRAME",
    };

    const localWarningsCount = this.warnings.length;
    this.buildCreateMutationFromLookup(normalized, lookupId, parentContext, nodeRef);
    if (this.warnings.length === localWarningsCount && instruction.updates.type === undefined) {
      this.warnings.push(
        `Modify instruction for node ${instruction.nodeId} did not specify a type. Runtime checks will determine whether text/instance-specific mutations are valid.`,
      );
    }
  }

  private buildCreateMutationFromLookup(
    node: DeclarativeCreateInstruction,
    lookupId: string,
    parentContext: { parentRef: string; parentAutoLayout: boolean },
    nodeRef: string,
  ): void {
    const isAutoLayout = node.layout === "VERTICAL" || node.layout === "HORIZONTAL" || node.layout === "GRID";
    if (node.layout && node.layout !== "NONE") {
      this.knownNodes.set(nodeRef, { isAutoLayout });
      const layoutModeId = this.addOperation({
        kind: "setLayoutMode",
        nodeRef,
        dependsOn: [lookupId],
        payload: { layoutMode: node.layout },
        meta: { affectsLayout: true },
      });

      if (node.padding !== undefined || node.gap !== undefined) {
        this.addOperation({
          kind: "setLayoutProperties",
          nodeRef,
          dependsOn: [layoutModeId],
          payload: {
            padding: normalizePadding(node.padding),
            gap: node.gap ?? null,
          },
          meta: { affectsLayout: true },
        });
      }
    }

    if (typeof node.width === "number" || typeof node.height === "number") {
      const resizeId = this.addOperation({
        kind: "resize",
        nodeRef,
        dependsOn: [lookupId],
        payload: {
          width: node.width ?? null,
          height: node.height ?? null,
        },
      });

      if (node.primaryAxisSizingMode || node.counterAxisSizingMode) {
        this.addOperation({
          kind: "setSizingModes",
          nodeRef,
          dependsOn: [resizeId],
          payload: {
            primaryAxisSizingMode: node.primaryAxisSizingMode ?? null,
            counterAxisSizingMode: node.counterAxisSizingMode ?? null,
          },
          meta: { affectsLayout: true },
        });
      }
    } else if (node.primaryAxisSizingMode || node.counterAxisSizingMode) {
      this.addOperation({
        kind: "setSizingModes",
        nodeRef,
        dependsOn: [lookupId],
        payload: {
          primaryAxisSizingMode: node.primaryAxisSizingMode ?? null,
          counterAxisSizingMode: node.counterAxisSizingMode ?? null,
        },
        meta: { affectsLayout: true },
      });
    }

    if (node.constraints) {
      this.addOperation({
        kind: "setConstraints",
        nodeRef,
        dependsOn: [lookupId],
        payload: {
          horizontal: node.constraints.horizontal,
          vertical: node.constraints.vertical,
        },
        meta: {
          parentRef: parentContext.parentRef,
          parentAutoLayout: parentContext.parentAutoLayout,
          affectsLayout: true,
        },
      });
    }

    if (node.name) {
      this.addOperation({
        kind: "setName",
        nodeRef,
        dependsOn: [lookupId],
        payload: { name: node.name },
      });
    }

    if (node.layoutSizingHorizontal || node.layoutSizingVertical) {
      this.addOperation({
        kind: "setLayoutSizing",
        nodeRef,
        dependsOn: [lookupId],
        payload: {
          horizontal: node.layoutSizingHorizontal ?? null,
          vertical: node.layoutSizingVertical ?? null,
        },
        meta: {
          parentRef: parentContext.parentRef,
          parentAutoLayout: parentContext.parentAutoLayout,
          affectsLayout: true,
        },
      });
    }

    if (typeof node.opacity === "number") {
      this.addOperation({
        kind: "setOpacity",
        nodeRef,
        dependsOn: [lookupId],
        payload: { opacity: node.opacity },
      });
    }

    if (typeof node.cornerRadius === "number") {
      this.addOperation({
        kind: "setCornerRadius",
        nodeRef,
        dependsOn: [lookupId],
        payload: { cornerRadius: node.cornerRadius },
      });
    }

    if (node.rectangleCornerRadii) {
      this.addOperation({
        kind: "setRectangleCornerRadii",
        nodeRef,
        dependsOn: [lookupId],
        payload: { rectangleCornerRadii: [...node.rectangleCornerRadii] },
      });
    }

    const fills = this.resolveNodeFills(node);
    if (fills.length > 0) {
      this.addOperation({
        kind: node.type === "TEXT" ? "setTextFills" : "setFills",
        nodeRef,
        dependsOn: [lookupId],
        payload: { fills },
      });
    }

    if (this.hasTextMutations(node)) {
      const fontDescriptor = normalizeFontDescriptor(node);
      const loadFontId = this.addOperation({
        kind: "loadFont",
        nodeRef,
        dependsOn: [lookupId],
        payload: fontDescriptor,
        meta: { affectsText: true },
      });

      if (fontDescriptor.fontFamily || fontDescriptor.fontStyle) {
        this.addOperation({
          kind: "setFontName",
          nodeRef,
          dependsOn: [loadFontId],
          payload: fontDescriptor,
          meta: { affectsText: true },
        });
      }

      if (typeof node.fontSize === "number") {
        this.addOperation({
          kind: "setFontSize",
          nodeRef,
          dependsOn: [loadFontId],
          payload: { fontSize: node.fontSize },
          meta: { affectsText: true },
        });
      }

      let charactersId: string | null = null;
      if (typeof node.content === "string") {
        charactersId = this.addOperation({
          kind: "setCharacters",
          nodeRef,
          dependsOn: [loadFontId],
          payload: { content: node.content },
          meta: { affectsText: true },
        });
      }

      if (node.textAutoResize) {
        this.addOperation({
          kind: "setTextAutoResize",
          nodeRef,
          dependsOn: [charactersId ?? loadFontId],
          payload: { textAutoResize: node.textAutoResize },
          meta: { affectsText: true },
        });
      }
    }

    if (node.overrides && Object.keys(node.overrides).length > 0) {
      this.addOperation({
        kind: "setInstanceOverrides",
        nodeRef,
        dependsOn: [lookupId],
        payload: { overrides: node.overrides },
      });
    }
  }

  private resolveNodeFills(node: Partial<DeclarativeDesignNode>): DeclarativeFillSpec[] {
    if (node.fills && node.fills.length > 0) {
      return node.fills;
    }
    if (node.type === "TEXT" && node.color) {
      return [{ type: "SOLID", color: node.color }];
    }
    return [];
  }

  private hasTextMutations(node: Partial<DeclarativeDesignNode>): boolean {
    return (
      typeof node.content === "string" ||
      typeof node.fontSize === "number" ||
      typeof node.fontWeight === "number" ||
      typeof node.fontWeight === "string" ||
      Boolean(node.fontFamily) ||
      Boolean(node.fontStyle) ||
      Boolean(node.textAutoResize)
    );
  }

  private addOperation(input: {
    kind: OperationKind;
    nodeRef?: string;
    payload?: Record<string, unknown>;
    dependsOn?: string[];
    meta?: FigmaOperation["meta"];
  }): string {
    const operation: FigmaOperation = {
      id: `op_${++this.sequence}`,
      kind: input.kind,
      nodeRef: input.nodeRef,
      payload: input.payload ?? {},
      dependsOn: [...(input.dependsOn ?? [])],
      meta: input.meta,
    };
    this.operations.push(operation);
    return operation.id;
  }

  private nextRef(prefix: string): string {
    this.refSequence += 1;
    return `${prefix}_${this.refSequence}`;
  }
}

export class OperationValidator {
  validate(operations: FigmaOperation[]): OperationValidationResult {
    const fixed = operations.map((operation) => ({
      ...operation,
      dependsOn: [...operation.dependsOn],
      payload: { ...(operation.payload ?? {}) },
      meta: operation.meta ? { ...operation.meta } : undefined,
    }));

    const warnings: string[] = [];
    const errors: string[] = [];

    const byNode = groupByNode(fixed);

    for (const [nodeRef, ops] of byNode) {
      const createLike = findFirst(ops, (operation) =>
        ["createNode", "instantiateComponent", "lookupNode"].includes(operation.kind),
      );
      const append = findFirst(ops, (operation) => operation.kind === "appendChild");
      const layoutMode = findFirst(ops, (operation) => operation.kind === "setLayoutMode");
      const resize = findFirst(ops, (operation) => operation.kind === "resize");
      const sizingModes = findFirst(ops, (operation) => operation.kind === "setSizingModes");
      const layoutSizing = findFirst(ops, (operation) => operation.kind === "setLayoutSizing");
      const constraints = findFirst(ops, (operation) => operation.kind === "setConstraints");
      const cornerRadius = findFirst(ops, (operation) => operation.kind === "setCornerRadius");
      const rectangleCornerRadii = findFirst(
        ops,
        (operation) => operation.kind === "setRectangleCornerRadii",
      );
      const loadFont = findFirst(ops, (operation) => operation.kind === "loadFont");
      const characters = findFirst(ops, (operation) => operation.kind === "setCharacters");
      const textAutoResize = findFirst(ops, (operation) => operation.kind === "setTextAutoResize");
      const textOps = ops.filter((operation) =>
        ["setFontName", "setFontSize", "setCharacters", "setTextAutoResize", "setTextFills"].includes(
          operation.kind,
        ),
      );

      if (layoutSizing) {
        const horizontal = layoutSizing.payload?.horizontal;
        const vertical = layoutSizing.payload?.vertical;
        if (horizontal === "FILL" || vertical === "FILL") {
          if (!append) {
            errors.push(
              `Rule 1 violation for ${nodeRef}: FILL sizing requires appendChild before layout sizing.`,
            );
          } else {
            ensureDependency(layoutSizing, append.id);
          }
        }
      }

      if (sizingModes && resize) {
        ensureDependency(sizingModes, resize.id);
      }

      if (layoutMode) {
        for (const operation of ops) {
          if (operation.kind === "setLayoutProperties") {
            ensureDependency(operation, layoutMode.id);
          }
        }
      }

      const genericVariableBindings = ops.filter(
        (operation) => operation.kind === "setVariableBinding",
      );
      if (genericVariableBindings.length > 0) {
        errors.push(
          `Rule 3 violation for ${nodeRef}: color bindings must use paint variable bindings rather than generic setVariableBinding operations.`,
        );
      }

      if (textOps.length > 0) {
        if (!loadFont) {
          errors.push(`Rule 5 violation for ${nodeRef}: text mutations require loadFontAsync first.`);
        } else {
          for (const textOp of textOps) {
            ensureDependency(textOp, loadFont.id);
          }
        }

        if (characters && textAutoResize) {
          ensureDependency(textAutoResize, characters.id);
        } else if (textAutoResize && !characters && loadFont) {
          ensureDependency(textAutoResize, loadFont.id);
          warnings.push(
            `Rule 4 fallback for ${nodeRef}: textAutoResize is being applied without a characters update, so it will run immediately after font loading.`,
          );
        }
      }

      if (constraints?.meta?.parentAutoLayout) {
        removeOperation(fixed, constraints.id);
        warnings.push(
          `Rule 6 applied for ${nodeRef}: removed constraints because the node sits inside an auto-layout parent.`,
        );
      }

      if (cornerRadius && rectangleCornerRadii) {
        removeOperation(fixed, cornerRadius.id);
        warnings.push(
          `Rule 7 applied for ${nodeRef}: removed cornerRadius because rectangleCornerRadii is more specific.`,
        );
      }

      if (!createLike && append && append.meta?.parentRef === undefined) {
        errors.push(`Unable to resolve parent reference for ${nodeRef}.`);
      }
    }

    let sorted: FigmaOperation[] = fixed;
    try {
      sorted = new OperationGraph().sortOperations(fixed);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }

    return {
      valid: errors.length === 0,
      operations: sorted,
      errors,
      warnings,
    };
  }
}

export class OperationCompiler {
  compile(operations: FigmaOperation[]): CompilationResult {
    const validator = new OperationValidator();
    const validation = validator.validate(operations);

    const resourceVars = new Map<string, string>();
    const nodeVars = new Map<string, string>();
    const emittedResources = {
      componentKeys: new Set<string>(),
      variableKeys: new Set<string>(),
    };
    const loadFontOps = validation.operations.filter((operation) => operation.kind === "loadFont");
    const bodyOps = validation.operations.filter((operation) => operation.kind !== "loadFont");

    const js: string[] = [];
    js.push("return (async function() {");
    js.push("  const nodeIds = {};");
    js.push("  const importedComponents = {};");
    js.push("  const importedVariables = {};");
    js.push("  const hexToFigmaRGB = (hex) => {");
    js.push("    const normalized = String(hex).replace('#', '').trim();");
    js.push("    const value = normalized.length === 3 ? normalized.split('').map((part) => part + part).join('') : normalized;");
    js.push("    if (value.length !== 6 && value.length !== 8) throw new Error(`Invalid hex color: ${hex}`);");
    js.push("    const alpha = value.length === 8 ? parseInt(value.slice(6, 8), 16) / 255 : 1;");
    js.push("    return {");
    js.push("      r: parseInt(value.slice(0, 2), 16) / 255,");
    js.push("      g: parseInt(value.slice(2, 4), 16) / 255,");
    js.push("      b: parseInt(value.slice(4, 6), 16) / 255,");
    js.push("      a: alpha,");
    js.push("    };");
    js.push("  };");
    js.push("  try {");

    for (const operation of dedupeFontLoads(loadFontOps)) {
      js.push(
        ...this
          .compileOperation(operation, nodeVars, resourceVars, emittedResources)
          .map((line) => `    ${line}`),
      );
    }

    for (const operation of bodyOps) {
      js.push(
        ...this
          .compileOperation(operation, nodeVars, resourceVars, emittedResources)
          .map((line) => `    ${line}`),
      );
    }

    js.push("    return { success: true, nodeIds };");
    js.push("  } catch (error) {");
    js.push("    return { success: false, error: error instanceof Error ? error.message : String(error), nodeIds };");
    js.push("  }");
    js.push("})()");

    const code = js.join("\n");
    new vm.Script(`(function(){\n${code}\n})`);
    return { code, validation };
  }

  private compileOperation(
    operation: FigmaOperation,
    nodeVars: Map<string, string>,
    resourceVars: Map<string, string>,
    emittedResources: {
      componentKeys: Set<string>;
      variableKeys: Set<string>;
    },
  ): string[] {
    const lines: string[] = [];
    const nodeVar = operation.nodeRef ? ensureVar(nodeVars, operation.nodeRef, "node") : null;
    const payload = operation.payload ?? {};

    switch (operation.kind) {
      case "lookupNode": {
        const nodeId = String(payload.nodeId);
        lines.push(`const ${nodeVar} = figma.getNodeById(${toJs(nodeId)});`);
        lines.push(`if (!${nodeVar}) throw new Error(${toJs(`Node ${nodeId} was not found.`)});`);
        lines.push(`nodeIds[${toJs(operation.nodeRef ?? nodeId)}] = ${nodeVar}.id;`);
        break;
      }
      case "createNode": {
        const nodeType = String(payload.nodeType);
        lines.push(`const ${nodeVar} = ${creationExpression(nodeType)};`);
        lines.push(`nodeIds[${toJs(operation.nodeRef ?? nodeType)}] = ${nodeVar}.id;`);
        break;
      }
      case "importComponent": {
        const componentKey = String(payload.componentKey);
        const componentVar = ensureVar(resourceVars, `component:${componentKey}`, "component");
        if (!emittedResources.componentKeys.has(componentKey)) {
          lines.push(
            `const ${componentVar} = importedComponents[${toJs(componentKey)}] ?? await figma.importComponentByKeyAsync(${toJs(componentKey)});`,
          );
          lines.push(`importedComponents[${toJs(componentKey)}] = ${componentVar};`);
          emittedResources.componentKeys.add(componentKey);
        }
        break;
      }
      case "instantiateComponent": {
        const componentKey = String(payload.componentKey);
        const componentVar = ensureVar(resourceVars, `component:${componentKey}`, "component");
        lines.push(`const ${nodeVar} = ${componentVar}.createInstance();`);
        lines.push(`nodeIds[${toJs(operation.nodeRef ?? componentKey)}] = ${nodeVar}.id;`);
        break;
      }
      case "appendChild": {
        const parentRef = String(payload.parentRef);
        const parentVar = parentRef === "currentPage" ? "figma.currentPage" : ensureVar(nodeVars, parentRef, "node");
        lines.push(`${parentVar}.appendChild(${nodeVar});`);
        break;
      }
      case "setName": {
        lines.push(`${nodeVar}.name = ${toJs(String(payload.name ?? ""))};`);
        break;
      }
      case "setLayoutMode": {
        lines.push(`${nodeVar}.layoutMode = ${toJs(String(payload.layoutMode))};`);
        break;
      }
      case "setLayoutProperties": {
        const padding = (payload.padding ?? {}) as DeclarativePadding;
        if (typeof padding.top === "number") lines.push(`${nodeVar}.paddingTop = ${padding.top};`);
        if (typeof padding.right === "number") lines.push(`${nodeVar}.paddingRight = ${padding.right};`);
        if (typeof padding.bottom === "number") lines.push(`${nodeVar}.paddingBottom = ${padding.bottom};`);
        if (typeof padding.left === "number") lines.push(`${nodeVar}.paddingLeft = ${padding.left};`);
        if (typeof payload.gap === "number") lines.push(`${nodeVar}.itemSpacing = ${payload.gap};`);
        break;
      }
      case "resize": {
        const width = payload.width;
        const height = payload.height;
        lines.push(
          `if (typeof ${nodeVar}.resize === "function") ${nodeVar}.resize(${typeof width === "number" ? width : `${nodeVar}.width`}, ${typeof height === "number" ? height : `${nodeVar}.height`});`,
        );
        break;
      }
      case "setSizingModes": {
        if (payload.primaryAxisSizingMode) {
          lines.push(`${nodeVar}.primaryAxisSizingMode = ${toJs(String(payload.primaryAxisSizingMode))};`);
        }
        if (payload.counterAxisSizingMode) {
          lines.push(`${nodeVar}.counterAxisSizingMode = ${toJs(String(payload.counterAxisSizingMode))};`);
        }
        break;
      }
      case "setLayoutSizing": {
        if (payload.horizontal) {
          lines.push(`${nodeVar}.layoutSizingHorizontal = ${toJs(String(payload.horizontal))};`);
        }
        if (payload.vertical) {
          lines.push(`${nodeVar}.layoutSizingVertical = ${toJs(String(payload.vertical))};`);
        }
        break;
      }
      case "setConstraints": {
        lines.push(
          `${nodeVar}.constraints = { horizontal: ${toJs(String(payload.horizontal))}, vertical: ${toJs(String(payload.vertical))} };`,
        );
        break;
      }
      case "setOpacity": {
        lines.push(`${nodeVar}.opacity = ${Number(payload.opacity)};`);
        break;
      }
      case "setCornerRadius": {
        lines.push(`${nodeVar}.cornerRadius = ${Number(payload.cornerRadius)};`);
        break;
      }
      case "setRectangleCornerRadii": {
        const radii = payload.rectangleCornerRadii as number[];
        lines.push(`${nodeVar}.rectangleCornerRadii = ${toJs(radii)};`);
        break;
      }
      case "loadFont": {
        const fontFamily = String(payload.fontFamily || "Inter");
        const fontStyle = String(payload.fontStyle || "Regular");
        lines.push(`await figma.loadFontAsync({ family: ${toJs(fontFamily)}, style: ${toJs(fontStyle)} });`);
        break;
      }
      case "setFontName": {
        const fontFamily = String(payload.fontFamily || "Inter");
        const fontStyle = String(payload.fontStyle || "Regular");
        lines.push(`if (${nodeVar}.type !== "TEXT") throw new Error(${toJs(`Node ${operation.nodeRef} is not a TEXT node.`)});`);
        lines.push(`${nodeVar}.fontName = { family: ${toJs(fontFamily)}, style: ${toJs(fontStyle)} };`);
        break;
      }
      case "setFontSize": {
        lines.push(`if (${nodeVar}.type !== "TEXT") throw new Error(${toJs(`Node ${operation.nodeRef} is not a TEXT node.`)});`);
        lines.push(`${nodeVar}.fontSize = ${Number(payload.fontSize)};`);
        break;
      }
      case "setCharacters": {
        lines.push(`if (${nodeVar}.type !== "TEXT") throw new Error(${toJs(`Node ${operation.nodeRef} is not a TEXT node.`)});`);
        lines.push(`${nodeVar}.characters = ${toJs(String(payload.content ?? ""))};`);
        break;
      }
      case "setTextAutoResize": {
        lines.push(`if (${nodeVar}.type !== "TEXT") throw new Error(${toJs(`Node ${operation.nodeRef} is not a TEXT node.`)});`);
        lines.push(`${nodeVar}.textAutoResize = ${toJs(String(payload.textAutoResize))};`);
        break;
      }
      case "setFills":
      case "setTextFills": {
        const fillLines = compileFillAssignment(
          nodeVar ?? "",
          payload.fills as DeclarativeFillSpec[],
          resourceVars,
          emittedResources.variableKeys,
        );
        if (operation.kind === "setTextFills") {
          lines.push(`if (${nodeVar}.type !== "TEXT") throw new Error(${toJs(`Node ${operation.nodeRef} is not a TEXT node.`)});`);
        }
        lines.push(...fillLines);
        break;
      }
      case "setInstanceOverrides": {
        lines.push(`if (${nodeVar}.type !== "INSTANCE") throw new Error(${toJs(`Node ${operation.nodeRef} is not an INSTANCE node.`)});`);
        lines.push(`${nodeVar}.setProperties(${toJs(payload.overrides ?? {})});`);
        break;
      }
      case "setVariableBinding": {
        lines.push(`// Unsupported generic variable binding operation for ${operation.nodeRef}`);
        break;
      }
      default:
        lines.push(`// Unhandled operation ${operation.kind}`);
    }

    return lines;
  }
}

export class AIResponseParser {
  parse(raw: string): ParsedAiResponse {
    const normalizedJson = extractJsonCandidate(raw);
    const parsed = JSON.parse(normalizedJson) as unknown;
    const instruction = normalizeParsedInstruction(parsed);

    return {
      instruction,
      normalizedJson: JSON.stringify(instruction, null, 2),
    };
  }
}

function normalizeParsedInstruction(parsed: unknown): DeclarativeInstruction {
  if (Array.isArray(parsed)) {
    return {
      action: "batch",
      operations: parsed.map((entry) => normalizeParsedInstruction(entry)),
    };
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("AI response did not contain a valid JSON object.");
  }

  const object = parsed as Record<string, unknown>;

  if (object.action === "batch" && Array.isArray(object.operations)) {
    return {
      action: "batch",
      operations: object.operations.map((entry) => normalizeParsedInstruction(entry)),
    };
  }

  if (typeof object.nodeId === "string" && object.updates && typeof object.updates === "object") {
    return {
      action: "modify",
      nodeId: object.nodeId,
      updates: normalizeNodeSpec(object.updates as Record<string, unknown>),
    };
  }

  if (typeof object.targetNodeId === "string") {
    const { targetNodeId, ...rest } = object;
    return {
      action: "modify",
      nodeId: targetNodeId,
      updates: normalizeNodeSpec(rest),
    };
  }

  return normalizeNodeSpec(object) as DeclarativeCreateInstruction;
}

function normalizeNodeSpec(raw: Record<string, unknown>): DeclarativeCreateInstruction {
  const node: DeclarativeCreateInstruction = {
    action: raw.action === "create" ? "create" : undefined,
    type: String(raw.type ?? "FRAME") as NodeType,
  };

  if (typeof raw.refId === "string") node.refId = raw.refId;
  if (typeof raw.name === "string") node.name = raw.name;
  if (typeof raw.width === "number") node.width = raw.width;
  if (typeof raw.height === "number") node.height = raw.height;
  if (typeof raw.layout === "string") node.layout = raw.layout as LayoutMode;
  if (typeof raw.gap === "number") node.gap = raw.gap;
  if (typeof raw.padding === "number" || (raw.padding && typeof raw.padding === "object")) {
    node.padding = raw.padding as number | DeclarativePadding;
  }
  if (Array.isArray(raw.fills)) {
    node.fills = raw.fills.map((fill) => ({
      type: "SOLID",
      color: typeof (fill as Record<string, unknown>).color === "string" ? String((fill as Record<string, unknown>).color) : undefined,
      opacity: typeof (fill as Record<string, unknown>).opacity === "number" ? Number((fill as Record<string, unknown>).opacity) : undefined,
      variableKey: typeof (fill as Record<string, unknown>).variableKey === "string" ? String((fill as Record<string, unknown>).variableKey) : undefined,
    }));
  }
  if (typeof raw.color === "string") node.color = raw.color;
  if (typeof raw.opacity === "number") node.opacity = raw.opacity;
  if (typeof raw.cornerRadius === "number") node.cornerRadius = raw.cornerRadius;
  if (Array.isArray(raw.rectangleCornerRadii) && raw.rectangleCornerRadii.length === 4) {
    node.rectangleCornerRadii = raw.rectangleCornerRadii.map(Number) as [number, number, number, number];
  }
  if (typeof raw.primaryAxisSizingMode === "string") {
    node.primaryAxisSizingMode = raw.primaryAxisSizingMode as AutoLayoutSizingMode;
  }
  if (typeof raw.counterAxisSizingMode === "string") {
    node.counterAxisSizingMode = raw.counterAxisSizingMode as AutoLayoutSizingMode;
  }
  if (typeof raw.layoutSizingHorizontal === "string") {
    node.layoutSizingHorizontal = raw.layoutSizingHorizontal as ChildLayoutSizingMode;
  }
  if (typeof raw.layoutSizingVertical === "string") {
    node.layoutSizingVertical = raw.layoutSizingVertical as ChildLayoutSizingMode;
  }
  if (raw.constraints && typeof raw.constraints === "object") {
    const constraints = raw.constraints as Record<string, unknown>;
    node.constraints = {
      horizontal: String(constraints.horizontal ?? "LEFT") as ConstraintAxisHorizontal,
      vertical: String(constraints.vertical ?? "TOP") as ConstraintAxisVertical,
    };
  }
  if (typeof raw.content === "string") node.content = raw.content;
  if (typeof raw.fontSize === "number") node.fontSize = raw.fontSize;
  if (typeof raw.fontWeight === "number" || typeof raw.fontWeight === "string") {
    node.fontWeight = raw.fontWeight;
  }
  if (typeof raw.fontFamily === "string") node.fontFamily = raw.fontFamily;
  if (typeof raw.fontStyle === "string") node.fontStyle = raw.fontStyle;
  if (typeof raw.textAutoResize === "string") node.textAutoResize = raw.textAutoResize as TextAutoResize;
  if (typeof raw.componentKey === "string") node.componentKey = raw.componentKey;
  if (raw.overrides && typeof raw.overrides === "object") {
    node.overrides = raw.overrides as Record<string, string | boolean | number>;
  }
  if (Array.isArray(raw.children)) {
    node.children = raw.children.map((child) => normalizeNodeSpec(child as Record<string, unknown>));
  }

  return node;
}

function normalizePadding(padding: number | DeclarativePadding | undefined): DeclarativePadding {
  if (typeof padding === "number") {
    return {
      top: padding,
      right: padding,
      bottom: padding,
      left: padding,
    };
  }
  return {
    top: padding?.top,
    right: padding?.right,
    bottom: padding?.bottom,
    left: padding?.left,
  };
}

function normalizeFontDescriptor(node: Partial<DeclarativeDesignNode>): {
  fontFamily: string;
  fontStyle: string;
} {
  const family = node.fontFamily || "Inter";
  if (node.fontStyle) {
    return { fontFamily: family, fontStyle: node.fontStyle };
  }

  if (typeof node.fontWeight === "string") {
    return { fontFamily: family, fontStyle: node.fontWeight };
  }

  if (typeof node.fontWeight === "number") {
    return { fontFamily: family, fontStyle: mapFontWeightToStyle(node.fontWeight) };
  }

  return { fontFamily: family, fontStyle: "Regular" };
}

function mapFontWeightToStyle(weight: number): string {
  if (weight >= 800) return "Extra Bold";
  if (weight >= 700) return "Bold";
  if (weight >= 600) return "Semi Bold";
  if (weight >= 500) return "Medium";
  if (weight >= 300) return "Light";
  return "Regular";
}

function groupByNode(operations: FigmaOperation[]): Map<string, FigmaOperation[]> {
  const map = new Map<string, FigmaOperation[]>();
  for (const operation of operations) {
    const key = operation.nodeRef ?? "__global__";
    const list = map.get(key) ?? [];
    list.push(operation);
    map.set(key, list);
  }
  return map;
}

function findFirst(
  operations: FigmaOperation[],
  predicate: (operation: FigmaOperation) => boolean,
): FigmaOperation | null {
  return operations.find(predicate) ?? null;
}

function ensureDependency(operation: FigmaOperation, dependencyId: string): void {
  if (!operation.dependsOn.includes(dependencyId)) {
    operation.dependsOn.push(dependencyId);
  }
}

function removeOperation(operations: FigmaOperation[], operationId: string): void {
  const targetIndex = operations.findIndex((operation) => operation.id === operationId);
  if (targetIndex < 0) {
    return;
  }

  operations.splice(targetIndex, 1);
  for (const operation of operations) {
    operation.dependsOn = operation.dependsOn.filter((dependencyId) => dependencyId !== operationId);
  }
}

function ensureVar(
  map: Map<string, string>,
  key: string,
  prefix: string,
): string {
  const existing = map.get(key);
  if (existing) {
    return existing;
  }
  const safe = `${prefix}_${sanitizeIdentifier(key)}`;
  map.set(key, safe);
  return safe;
}

function sanitizeIdentifier(value: string): string {
  return value.replace(/[^a-zA-Z0-9_]+/g, "_").replace(/^(\d)/, "_$1");
}

function creationExpression(nodeType: string): string {
  switch (nodeType) {
    case "FRAME":
      return "figma.createFrame()";
    case "TEXT":
      return "figma.createText()";
    case "RECTANGLE":
      return "figma.createRectangle()";
    case "ELLIPSE":
      return "figma.createEllipse()";
    case "GROUP":
      return "figma.group([], figma.currentPage)";
    case "COMPONENT":
      return "figma.createComponent()";
    case "COMPONENT_SET":
      return "figma.combineAsVariants([], figma.currentPage)";
    default:
      return "figma.createFrame()";
  }
}

function compileFillAssignment(
  nodeVar: string,
  fills: DeclarativeFillSpec[],
  resourceVars: Map<string, string>,
  emittedVariableKeys: Set<string>,
): string[] {
  const lines: string[] = [];
  const fillRefs: string[] = [];

  fills.forEach((fill, index) => {
    const fillRef = `${nodeVar}_fill_${index}`;
    fillRefs.push(fillRef);
    lines.push(`let ${fillRef} = { type: "SOLID", color: hexToFigmaRGB(${toJs(fill.color ?? "#ffffff")}), opacity: ${typeof fill.opacity === "number" ? fill.opacity : 1} };`);
    if (fill.variableKey) {
      const variableVar = ensureVar(resourceVars, `variable:${fill.variableKey}`, "variable");
      if (!emittedVariableKeys.has(fill.variableKey)) {
        lines.push(`const ${variableVar} = importedVariables[${toJs(fill.variableKey)}] ?? await figma.variables.importVariableByKeyAsync(${toJs(fill.variableKey)});`);
        lines.push(`importedVariables[${toJs(fill.variableKey)}] = ${variableVar};`);
        emittedVariableKeys.add(fill.variableKey);
      }
      lines.push(`${fillRef} = figma.variables.setBoundVariableForPaint(${fillRef}, "color", ${variableVar});`);
    }
  });

  lines.push(`${nodeVar}.fills = [${fillRefs.join(", ")}];`);
  return lines;
}

function dedupeFontLoads(operations: FigmaOperation[]): FigmaOperation[] {
  const seen = new Set<string>();
  return operations.filter((operation) => {
    const key = JSON.stringify(operation.payload ?? {});
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function toJs(value: unknown): string {
  return JSON.stringify(value);
}

function extractJsonCandidate(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }

  const startIndices = [raw.indexOf("{"), raw.indexOf("[")].filter((index) => index >= 0);
  if (startIndices.length === 0) {
    throw new Error("AI response did not include JSON.");
  }

  const start = Math.min(...startIndices);
  const openChar = raw[start];
  const closeChar = openChar === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === openChar) {
      depth += 1;
    } else if (char === closeChar) {
      depth -= 1;
      if (depth === 0) {
        return raw.slice(start, index + 1).trim();
      }
    }
  }

  throw new Error("AI response contained malformed JSON.");
}
