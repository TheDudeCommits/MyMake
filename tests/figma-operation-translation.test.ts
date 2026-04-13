import test from "node:test";
import assert from "node:assert/strict";

import {
  AIResponseParser,
  OperationCompiler,
  OperationGraph,
  OperationValidator,
  type FigmaOperation,
} from "@/lib/figma/operation-translation";

function findOperationIndex(
  operations: FigmaOperation[],
  kind: FigmaOperation["kind"],
  nodeRef: string,
): number {
  return operations.findIndex(
    (operation) => operation.kind === kind && operation.nodeRef === nodeRef,
  );
}

test("rule 1: FILL sizing is ordered after appendChild", () => {
  const graph = new OperationGraph();
  const { operations } = graph.build({
    type: "FRAME",
    refId: "root_frame",
    layout: "VERTICAL",
    children: [
      {
        type: "RECTANGLE",
        refId: "fill_child",
        layoutSizingHorizontal: "FILL",
      },
    ],
  });

  const validation = new OperationValidator().validate(operations);
  const appendIndex = findOperationIndex(validation.operations, "appendChild", "fill_child");
  const sizingIndex = findOperationIndex(validation.operations, "setLayoutSizing", "fill_child");

  assert.equal(validation.valid, true);
  assert.ok(appendIndex >= 0);
  assert.ok(sizingIndex >= 0);
  assert.ok(appendIndex < sizingIndex);
});

test("rule 2: resize runs before sizing mode updates", () => {
  const graph = new OperationGraph();
  const { operations } = graph.build({
    type: "FRAME",
    refId: "resizable_frame",
    width: 320,
    height: 180,
    primaryAxisSizingMode: "AUTO",
    counterAxisSizingMode: "FIXED",
  });

  const validation = new OperationValidator().validate(operations);
  const resizeIndex = findOperationIndex(validation.operations, "resize", "resizable_frame");
  const sizingIndex = findOperationIndex(
    validation.operations,
    "setSizingModes",
    "resizable_frame",
  );

  assert.equal(validation.valid, true);
  assert.ok(resizeIndex >= 0);
  assert.ok(sizingIndex >= 0);
  assert.ok(resizeIndex < sizingIndex);
});

test("rule 3: color variables compile through setBoundVariableForPaint", () => {
  const graph = new OperationGraph();
  const { operations } = graph.build({
    type: "RECTANGLE",
    refId: "token_rect",
    fills: [
      {
        type: "SOLID",
        color: "#ffffff",
        variableKey: "VariableID:1:2",
      },
    ],
  });

  const result = new OperationCompiler().compile(operations);

  assert.equal(result.validation.valid, true);
  assert.match(result.code, /setBoundVariableForPaint/);
  assert.doesNotMatch(result.code, /\bsetBoundVariable\s*\(/);
});

test("rule 4: text characters are set after loadFontAsync and before textAutoResize", () => {
  const graph = new OperationGraph();
  const { operations } = graph.build({
    type: "TEXT",
    refId: "headline",
    content: "Title",
    fontSize: 24,
    fontWeight: "Bold",
    textAutoResize: "HEIGHT",
  });

  const validation = new OperationValidator().validate(operations);
  const loadFontIndex = findOperationIndex(validation.operations, "loadFont", "headline");
  const charactersIndex = findOperationIndex(validation.operations, "setCharacters", "headline");
  const autoResizeIndex = findOperationIndex(
    validation.operations,
    "setTextAutoResize",
    "headline",
  );

  assert.equal(validation.valid, true);
  assert.ok(loadFontIndex >= 0);
  assert.ok(charactersIndex >= 0);
  assert.ok(autoResizeIndex >= 0);
  assert.ok(loadFontIndex < charactersIndex);
  assert.ok(charactersIndex < autoResizeIndex);
});

test("rule 5: validator reorders text operations so loadFontAsync happens first", () => {
  const operations: FigmaOperation[] = [
    {
      id: "op_characters",
      kind: "setCharacters",
      nodeRef: "text_1",
      payload: { content: "Hello" },
      dependsOn: [],
    },
    {
      id: "op_font_size",
      kind: "setFontSize",
      nodeRef: "text_1",
      payload: { fontSize: 16 },
      dependsOn: [],
    },
    {
      id: "op_font_load",
      kind: "loadFont",
      nodeRef: "text_1",
      payload: { fontFamily: "Inter", fontStyle: "Regular" },
      dependsOn: [],
    },
  ];

  const validation = new OperationValidator().validate(operations);

  const loadFontIndex = findOperationIndex(validation.operations, "loadFont", "text_1");
  const charactersIndex = findOperationIndex(validation.operations, "setCharacters", "text_1");
  const fontSizeIndex = findOperationIndex(validation.operations, "setFontSize", "text_1");

  assert.equal(validation.valid, true);
  assert.ok(loadFontIndex >= 0);
  assert.ok(charactersIndex >= 0);
  assert.ok(fontSizeIndex >= 0);
  assert.ok(loadFontIndex < charactersIndex);
  assert.ok(loadFontIndex < fontSizeIndex);
});

test("rule 6: validator removes constraints for auto-layout children", () => {
  const graph = new OperationGraph();
  const { operations } = graph.build({
    type: "FRAME",
    refId: "auto_layout_parent",
    layout: "VERTICAL",
    children: [
      {
        type: "RECTANGLE",
        refId: "auto_layout_child",
        constraints: { horizontal: "LEFT_RIGHT", vertical: "TOP_BOTTOM" },
      },
    ],
  });

  const validation = new OperationValidator().validate(operations);
  const constraintIndex = findOperationIndex(
    validation.operations,
    "setConstraints",
    "auto_layout_child",
  );

  assert.equal(validation.valid, true);
  assert.equal(constraintIndex, -1);
  assert.ok(validation.warnings.some((warning) => warning.includes("Rule 6 applied")));
});

test("rule 7: validator keeps rectangleCornerRadii and removes cornerRadius when both exist", () => {
  const graph = new OperationGraph();
  const { operations } = graph.build({
    type: "RECTANGLE",
    refId: "rounded_rect",
    cornerRadius: 12,
    rectangleCornerRadii: [8, 12, 16, 20],
  });

  const validation = new OperationValidator().validate(operations);
  const cornerIndex = findOperationIndex(validation.operations, "setCornerRadius", "rounded_rect");
  const radiiIndex = findOperationIndex(
    validation.operations,
    "setRectangleCornerRadii",
    "rounded_rect",
  );

  assert.equal(validation.valid, true);
  assert.equal(cornerIndex, -1);
  assert.ok(radiiIndex >= 0);
  assert.ok(validation.warnings.some((warning) => warning.includes("Rule 7 applied")));
});

test("rule 8: validator ensures layoutMode is applied before layout properties", () => {
  const operations: FigmaOperation[] = [
    {
      id: "op_layout_props",
      kind: "setLayoutProperties",
      nodeRef: "frame_1",
      payload: { padding: { top: 16, right: 16, bottom: 16, left: 16 }, gap: 12 },
      dependsOn: [],
      meta: { affectsLayout: true },
    },
    {
      id: "op_layout_mode",
      kind: "setLayoutMode",
      nodeRef: "frame_1",
      payload: { layoutMode: "VERTICAL" },
      dependsOn: [],
      meta: { affectsLayout: true },
    },
  ];

  const validation = new OperationValidator().validate(operations);
  const layoutModeIndex = findOperationIndex(validation.operations, "setLayoutMode", "frame_1");
  const layoutPropsIndex = findOperationIndex(
    validation.operations,
    "setLayoutProperties",
    "frame_1",
  );
  const layoutPropsOperation = validation.operations[layoutPropsIndex];

  assert.equal(validation.valid, true);
  assert.ok(layoutModeIndex >= 0);
  assert.ok(layoutPropsIndex >= 0);
  assert.ok(layoutModeIndex < layoutPropsIndex);
  assert.ok(layoutPropsOperation?.dependsOn.includes("op_layout_mode"));
});

test("compiler returns executable plugin code and parser supports modify instructions", () => {
  const parser = new AIResponseParser();
  const parsed = parser.parse(`
    The requested change is:
    \`\`\`json
    {
      "nodeId": "123:456",
      "updates": {
        "type": "TEXT",
        "content": "Updated copy",
        "fontSize": 20
      }
    }
    \`\`\`
  `);

  const graph = new OperationGraph();
  const { operations } = graph.build(parsed.instruction);
  const compiled = new OperationCompiler().compile(operations);

  assert.equal(parsed.instruction.action, "modify");
  assert.match(compiled.code, /^return\s+\(async function\(\)/);
  assert.match(compiled.code, /return \{ success: true, nodeIds \};/);
  assert.equal(compiled.validation.valid, true);
});
