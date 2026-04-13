import test from "node:test";
import assert from "node:assert/strict";

import type {
  GetFileResponse,
  GetLocalVariablesResponse,
} from "@figma/rest-api-spec/dist/api_types";

import { serializeFigmaDesignContext } from "@/lib/figma/design-context-serializer";

const fileResponse = {
  document: {
    id: "0:0",
    name: "Document",
    type: "DOCUMENT",
    visible: true,
    locked: false,
    scrollBehavior: "SCROLLS",
    children: [
      {
        id: "1:1",
        name: "Page 1",
        type: "CANVAS",
        visible: true,
        locked: false,
        scrollBehavior: "SCROLLS",
        backgroundColor: { r: 1, g: 1, b: 1, a: 1 },
        prototypeStartNodeID: null,
        flowStartingPoints: [],
        prototypeDevice: { type: "NONE", rotation: "NONE" },
        exportSettings: [],
        children: [
          {
            id: "2:1",
            name: "Card",
            type: "FRAME",
            visible: true,
            locked: false,
            scrollBehavior: "SCROLLS",
            absoluteBoundingBox: { x: 0, y: 0, width: 320, height: 180 },
            absoluteRenderBounds: { x: 0, y: 0, width: 320, height: 180 },
            blendMode: "PASS_THROUGH",
            opacity: 1,
            layoutMode: "VERTICAL",
            primaryAxisAlignItems: "MIN",
            counterAxisAlignItems: "MIN",
            primaryAxisSizingMode: "AUTO",
            counterAxisSizingMode: "AUTO",
            paddingTop: 24,
            paddingRight: 24,
            paddingBottom: 24,
            paddingLeft: 24,
            itemSpacing: 16,
            fills: [
              {
                type: "SOLID",
                visible: true,
                opacity: 1,
                blendMode: "NORMAL",
                color: { r: 1, g: 1, b: 1, a: 1 },
              },
            ],
            strokes: [
              {
                type: "SOLID",
                visible: true,
                opacity: 1,
                blendMode: "NORMAL",
                color: { r: 0.9, g: 0.91, b: 0.93, a: 1 },
              },
            ],
            strokeWeight: 1,
            effects: [
              {
                type: "DROP_SHADOW",
                visible: true,
                blendMode: "NORMAL",
                color: { r: 0, g: 0, b: 0, a: 0.16 },
                offset: { x: 0, y: 6 },
                radius: 16,
                showShadowBehindNode: true,
              },
            ],
            clipsContent: false,
            exportSettings: [],
            boundVariables: {
              itemSpacing: { type: "VARIABLE_ALIAS", id: "var-spacing-md" },
            },
            children: [
              {
                id: "2:2",
                name: "Title",
                type: "TEXT",
                visible: true,
                locked: false,
                scrollBehavior: "SCROLLS",
                absoluteBoundingBox: { x: 24, y: 24, width: 200, height: 32 },
                absoluteRenderBounds: { x: 24, y: 24, width: 200, height: 32 },
                blendMode: "NORMAL",
                opacity: 1,
                exportSettings: [],
                fills: [],
                effects: [],
                characters: "Revenue overview",
                style: {
                  fontFamily: "Inter",
                  fontStyle: "Bold",
                  fontWeight: 700,
                  fontSize: 24,
                  textAlignHorizontal: "LEFT",
                  textAlignVertical: "TOP",
                  fills: [
                    {
                      type: "SOLID",
                      visible: true,
                      opacity: 1,
                      blendMode: "NORMAL",
                      color: { r: 0.23, g: 0.51, b: 0.96, a: 1 },
                      boundVariables: {
                        color: { type: "VARIABLE_ALIAS", id: "var-color-primary" },
                      },
                    },
                  ],
                  boundVariables: {
                    fontSize: { type: "VARIABLE_ALIAS", id: "var-font-title" },
                  },
                },
                characterStyleOverrides: [],
                styleOverrideTable: {},
                lineTypes: ["NONE"],
                lineIndentations: [0],
              },
              {
                id: "2:3",
                name: "CTA / Primary",
                type: "INSTANCE",
                visible: true,
                locked: false,
                scrollBehavior: "SCROLLS",
                absoluteBoundingBox: { x: 24, y: 88, width: 144, height: 48 },
                absoluteRenderBounds: { x: 24, y: 88, width: 144, height: 48 },
                blendMode: "PASS_THROUGH",
                opacity: 1,
                exportSettings: [],
                fills: [],
                strokes: [],
                effects: [],
                clipsContent: false,
                componentId: "component:button",
                overrides: [
                  {
                    id: "2:3",
                    overriddenFields: ["characters"],
                  },
                ],
                componentProperties: {
                  Label: {
                    type: "TEXT",
                    value: "Open dashboard",
                  },
                },
                children: [],
              },
              {
                id: "2:4",
                name: "Invisible helper",
                type: "TEXT",
                visible: false,
                locked: false,
                scrollBehavior: "SCROLLS",
                absoluteBoundingBox: null,
                absoluteRenderBounds: null,
                blendMode: "NORMAL",
                opacity: 1,
                exportSettings: [],
                fills: [],
                effects: [],
                characters: "Skip me",
                style: {
                  fontFamily: "Inter",
                  fontStyle: "Regular",
                  fontWeight: 400,
                  fontSize: 12,
                  fills: [],
                },
                characterStyleOverrides: [],
                styleOverrideTable: {},
                lineTypes: ["NONE"],
                lineIndentations: [0],
              },
            ],
          },
        ],
      },
    ],
  },
  components: {
    "component:button": {
      key: "button-key",
      name: "Button / Primary",
      description: "",
      remote: false,
      componentSetId: "set:button",
      documentationLinks: [],
    },
  },
  componentSets: {
    "set:button": {
      key: "set-key",
      name: "Button",
      description: "",
      remote: false,
      documentationLinks: [],
    },
  },
  styles: {},
  schemaVersion: 0,
  name: "Serializer test file",
  role: "owner",
  lastModified: "2026-04-13T00:00:00.000Z",
  thumbnailUrl: "",
  version: "1",
  editorType: "figma",
} as unknown as GetFileResponse;

const localVariables = {
  status: 200,
  error: false,
  meta: {
    variables: {
      "var-spacing-md": {
        id: "var-spacing-md",
        key: "spacing-md",
        name: "spacing/md",
        variableCollectionId: "collection:core",
        resolvedType: "FLOAT",
        valuesByMode: {
          "mode:default": 16,
        },
        remote: false,
        description: "",
        hiddenFromPublishing: false,
        scopes: ["GAP"],
        codeSyntax: {},
      },
      "var-color-primary": {
        id: "var-color-primary",
        key: "color-primary",
        name: "color/primary",
        variableCollectionId: "collection:core",
        resolvedType: "COLOR",
        valuesByMode: {
          "mode:default": { r: 0.23, g: 0.51, b: 0.96, a: 1 },
        },
        remote: false,
        description: "",
        hiddenFromPublishing: false,
        scopes: ["TEXT_FILL"],
        codeSyntax: {},
      },
      "var-font-title": {
        id: "var-font-title",
        key: "font-title",
        name: "typography/title",
        variableCollectionId: "collection:core",
        resolvedType: "FLOAT",
        valuesByMode: {
          "mode:default": 24,
        },
        remote: false,
        description: "",
        hiddenFromPublishing: false,
        scopes: ["FONT_SIZE"],
        codeSyntax: {},
      },
    },
    variableCollections: {
      "collection:core": {
        id: "collection:core",
        key: "core-key",
        name: "Core",
        defaultModeId: "mode:default",
        modes: [{ modeId: "mode:default", name: "Default" }],
        remote: false,
        hiddenFromPublishing: false,
        variableIds: ["var-spacing-md", "var-color-primary", "var-font-title"],
      },
    },
  },
} as unknown as GetLocalVariablesResponse;

test("serializes sparse, semantic, and variable outputs for a Figma subtree", () => {
  const result = serializeFigmaDesignContext(fileResponse, "2:1", {
    localVariables,
  });

  assert.match(result.sparse, /<FRAME id="2:1" name="Card" x="0" y="0" w="320" h="180">/);
  assert.match(result.sparse, /<TEXT id="2:2" name="Title" x="24" y="24" w="200" h="32"\/>/);
  assert.doesNotMatch(result.sparse, /Invisible helper/);

  assert.match(result.semantic, /className="flex flex-col/);
  assert.match(result.semantic, /gap-4/);
  assert.match(result.semantic, /p-6/);
  assert.match(result.semantic, /<h3 className="[^"]*text-2xl[^"]*font-bold[^"]*text-\[#3b82f5\][^"]*">/i);
  assert.match(result.semantic, /instanceOf Button \/ Primary/);
  assert.match(result.semantic, /tokens textStyle=color\/primary, textStyle=typography\/title/i);

  assert.deepEqual(result.variables, {
    "color/primary": "#3b82f5",
    "spacing/md": "16px",
    "typography/title": "24px",
  });
  assert.ok(result.tokenEstimate > 0);
  assert.equal(result.warnings.length, 0);
});
