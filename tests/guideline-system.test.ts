import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import type {
  GetFileResponse,
  GetLocalVariablesResponse,
} from "@figma/rest-api-spec/dist/api_types";

import {
  GuidelineGenerator,
  GuidelineRouter,
  GuidelineStore,
  buildGuidelineSystemPrompt,
  createTempGuidelineRoot,
} from "@/lib/server/guidelines";

test("router loads routing, overview, and relevant guideline files within budget", async () => {
  const rootDir = createTempGuidelineRoot();
  const store = new GuidelineStore({ rootDir });

  store.addGuideline(
    "Guidelines.md",
    "# Guidelines\n\nIMPORTANT: Always use documented components and tokens first.",
  );
  store.addGuideline(
    "overview-components.md",
    "# Components overview\n\n- button\n- card\n- modal",
  );
  store.addGuideline(
    "overview-tokens.md",
    "# Tokens overview\n\n- color/primary: #3b82f6\n- spacing/md: 16px",
  );
  store.addGuideline(
    "components/button.md",
    "# Button\n\nUse button for primary and secondary CTAs.\n\n## Variants\n\nPrimary, Secondary",
  );
  store.addGuideline(
    "components/card.md",
    "# Card\n\nUse card for grouped content and summaries.",
  );
  store.addGuideline(
    "design-tokens/colors.md",
    "# Colors\n\n- color/primary: #3b82f6\n- color/surface: #ffffff",
  );
  store.addGuideline(
    "design-tokens/spacing.md",
    "# Spacing\n\n- spacing/md: 16px\n- spacing/lg: 24px",
  );

  const router = new GuidelineRouter(store, { tokenBudget: 600 });
  const loaded = await router.loadForPrompt(
    "Make the primary button use the brand color and slightly tighter spacing.",
  );

  assert.match(loaded, /Guidelines\.md/);
  assert.match(loaded, /overview-components\.md/);
  assert.match(loaded, /overview-tokens\.md/);
  assert.match(loaded, /components\/button\.md/);
  assert.match(loaded, /design-tokens\/colors\.md/);
  assert.match(loaded, /design-tokens\/spacing\.md/);
  assert.doesNotMatch(loaded, /components\/card\.md/);

  const usage = router.getTokenBudgetUsage();
  assert.ok(usage.used <= usage.budget);

  const systemPrompt = buildGuidelineSystemPrompt({
    loadedGuidelines: loaded,
    componentList: store.getComponentList(),
    tokenSummary: store.getTokenSummaryLines(),
  });
  assert.match(systemPrompt, /You are a design system-aware code generator/);
  assert.match(systemPrompt, /Available components:/);
  assert.match(systemPrompt, /Available tokens:/);
});

test("generator builds guideline markdown from a figma component library", async () => {
  const rootDir = createTempGuidelineRoot();
  const store = new GuidelineStore({ rootDir });

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
          id: "1:0",
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
              id: "2:0",
              name: "Button",
              type: "COMPONENT_SET",
              visible: true,
              locked: false,
              scrollBehavior: "SCROLLS",
              absoluteBoundingBox: { x: 0, y: 0, width: 240, height: 120 },
              absoluteRenderBounds: { x: 0, y: 0, width: 240, height: 120 },
              blendMode: "PASS_THROUGH",
              opacity: 1,
              clipsContent: false,
              layoutMode: "HORIZONTAL",
              primaryAxisAlignItems: "MIN",
              counterAxisAlignItems: "CENTER",
              paddingTop: 8,
              paddingRight: 8,
              paddingBottom: 8,
              paddingLeft: 8,
              itemSpacing: 8,
              fills: [],
              strokes: [],
              effects: [],
              exportSettings: [],
              componentPropertyDefinitions: {
                Size: {
                  type: "VARIANT",
                  defaultValue: "md",
                  variantOptions: ["sm", "md", "lg"],
                },
              },
              children: [
                {
                  id: "2:1",
                  name: "Button / Primary",
                  type: "COMPONENT",
                  visible: true,
                  locked: false,
                  scrollBehavior: "SCROLLS",
                  absoluteBoundingBox: { x: 0, y: 0, width: 112, height: 48 },
                  absoluteRenderBounds: { x: 0, y: 0, width: 112, height: 48 },
                  blendMode: "PASS_THROUGH",
                  opacity: 1,
                  clipsContent: false,
                  layoutMode: "HORIZONTAL",
                  primaryAxisAlignItems: "CENTER",
                  counterAxisAlignItems: "CENTER",
                  paddingTop: 12,
                  paddingRight: 20,
                  paddingBottom: 12,
                  paddingLeft: 20,
                  itemSpacing: 8,
                  fills: [
                    {
                      type: "SOLID",
                      visible: true,
                      opacity: 1,
                      blendMode: "NORMAL",
                      color: { r: 0.23, g: 0.51, b: 0.96, a: 1 },
                    },
                  ],
                  strokes: [],
                  effects: [],
                  exportSettings: [],
                  children: [
                    {
                      id: "2:2",
                      name: "Label",
                      type: "TEXT",
                      visible: true,
                      locked: false,
                      scrollBehavior: "SCROLLS",
                      absoluteBoundingBox: { x: 20, y: 12, width: 72, height: 24 },
                      absoluteRenderBounds: { x: 20, y: 12, width: 72, height: 24 },
                      blendMode: "NORMAL",
                      opacity: 1,
                      fills: [],
                      effects: [],
                      exportSettings: [],
                      characters: "Continue",
                      style: {
                        fontFamily: "Inter",
                        fontStyle: "Semi Bold",
                        fontWeight: 600,
                        fontSize: 16,
                        fills: [
                          {
                            type: "SOLID",
                            visible: true,
                            opacity: 1,
                            blendMode: "NORMAL",
                            color: { r: 1, g: 1, b: 1, a: 1 },
                          },
                        ],
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
      ],
    },
    components: {
      "2:1": {
        key: "button-primary",
        name: "Button / Primary",
        description: "Primary action button.",
        remote: false,
        componentSetId: "2:0",
        documentationLinks: [],
      },
    },
    componentSets: {
      "2:0": {
        key: "button-set",
        name: "Button",
        description: "Button variants and sizes.",
        remote: false,
        documentationLinks: [],
      },
    },
    styles: {},
    schemaVersion: 0,
    name: "UIKit",
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
        "var-color-primary": {
          id: "var-color-primary",
          key: "var-color-primary",
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
        "var-spacing-md": {
          id: "var-spacing-md",
          key: "var-spacing-md",
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
      },
      variableCollections: {
        "collection:core": {
          id: "collection:core",
          key: "collection:core",
          name: "Core",
          defaultModeId: "mode:default",
          modes: [{ modeId: "mode:default", name: "Default" }],
          remote: false,
          hiddenFromPublishing: false,
          variableIds: ["var-color-primary", "var-spacing-md"],
        },
      },
    },
  } as unknown as GetLocalVariablesResponse;

  const fetchMock: typeof fetch = async (input) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/variables/local")) {
      return new Response(JSON.stringify(localVariables), { status: 200 });
    }
    return new Response(JSON.stringify(fileResponse), { status: 200 });
  };

  const generator = new GuidelineGenerator(store, fetchMock);
  await generator.generateFromFigmaLibrary("file-key", "figma-token");

  const guidelines = fs.readFileSync(path.join(rootDir, "Guidelines.md"), "utf8");
  const buttonDoc = fs.readFileSync(path.join(rootDir, "components", "button.md"), "utf8");
  const colorsDoc = fs.readFileSync(path.join(rootDir, "design-tokens", "colors.md"), "utf8");
  const overviewDoc = fs.readFileSync(path.join(rootDir, "overview-components.md"), "utf8");

  assert.match(guidelines, /IMPORTANT: Always read this routing file first/);
  assert.match(guidelines, /components\/button\.md/);
  assert.match(buttonDoc, /# Button/);
  assert.match(buttonDoc, /\| Variant \| Node ID \| Description \| Frequency suggestion \|/);
  assert.match(buttonDoc, /Semantic snapshot/);
  assert.match(colorsDoc, /color\/primary/);
  assert.match(overviewDoc, /Button/);
});
