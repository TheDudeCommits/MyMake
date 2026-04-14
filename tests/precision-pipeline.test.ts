import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildEditPlan,
  buildSelectionTarget,
  collectContextGraph,
} from "@/lib/server/project-intelligence";
import type { SelectionPayload, SelectionTarget } from "@/lib/types";

async function createTempProject(structure: Record<string, string>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mymake-precision-"));
  await Promise.all(
    Object.entries(structure).map(async ([relativePath, content]) => {
      const absolutePath = path.join(root, relativePath);
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, content, "utf8");
    }),
  );
  return root;
}

function createSelection(overrides?: Partial<SelectionPayload>): SelectionPayload {
  return {
    route: "/",
    url: "https://example.com/preview/project",
    domPath: "article.profile-card > h3",
    selector: ".profile-card h3",
    scopeSelector: ".profile-card:nth-of-type(1)",
    scopedSelector: "h3",
    nearestFramerName: "Profile Card",
    framerPath: ["Dashboard", "Profile Card"],
    tagName: "h3",
    textContent: "Primary owner",
    attributes: {},
    classes: ["profile-card"],
    outerHtml: "<h3>Primary owner</h3>",
    boundingBox: { x: 12, y: 24, width: 220, height: 42 },
    role: null,
    href: null,
    src: null,
    editableProperties: ["text", "layout"],
    fingerprint: "profile-card-title",
    instanceScope: ".profile-card:nth-of-type(1)",
    contextTexts: ["Primary owner", "Growth fund"],
    visualType: "container",
    reactComponentStack: ["ProfileCard", "DashboardPage"],
    reactSourceHints: ["ProfileCard.tsx", "ProfileCard"],
    ...overrides,
  };
}

function createSelectionTarget(overrides: Partial<SelectionTarget> = {}): SelectionTarget {
  return {
    targetId: "selection-target",
    fingerprint: "selection-fingerprint",
    route: "/",
    label: "Profile Card",
    summary: "Profile card summary",
    sourceFilePath: "src/components/ProfileCard.tsx",
    sourceCandidates: [
      {
        path: "src/components/ProfileCard.tsx",
        score: 220,
        reason: "resolved from React source anchor",
        matchedTerms: ["profile", "card"],
      },
    ],
    confidence: 0.94,
    componentName: "Profile Card",
    sectionName: "Dashboard",
    repeatGroup: "profile-card",
    instanceScope: ".profile-card:nth-of-type(1)",
    instanceIndex: 1,
    scopeMode: "instance",
    visualType: "container",
    sourceAnchor: {
      filePath: "src/components/ProfileCard.tsx",
      line: 8,
      column: 3,
      componentName: "ProfileCard",
      ownerStack: ["DashboardPage", "ProfileCard"],
    },
    resolutionMethod: "react-source-anchor",
    styleSnapshot: {
      textColor: "#0f172a",
      lineColor: null,
      fillColor: null,
      backgroundColor: "#ffffff",
      borderRadius: "18px",
      opacity: "1",
      fontSize: "18px",
      fontWeight: "600",
      display: "flex",
      visibility: "visible",
      width: 220,
      height: 42,
      gap: "16px",
      rowGap: "12px",
      columnGap: "20px",
      padding: "24px",
      margin: null,
      imageSrc: "/images/avatar-a.png",
    },
    proofHandles: [
      { key: "text", label: "Text", value: "Primary owner", confidence: 0.98 },
      { key: "spacing-x", label: "Horizontal spacing", value: "20px", confidence: 0.82 },
      { key: "spacing-y", label: "Vertical spacing", value: "12px", confidence: 0.82 },
      { key: "radius", label: "Border radius", value: "18px", confidence: 0.88 },
      { key: "font-size", label: "Font size", value: "18px", confidence: 0.82 },
      { key: "image-src", label: "Image source", value: "/images/avatar-a.png", confidence: 0.96 },
    ],
    resolvedHandles: [
      { key: "text", label: "Text", confidence: 0.98, currentValue: "Primary owner" },
      { key: "spacing", label: "Spacing", confidence: 0.84, currentValue: "16px" },
      { key: "radius", label: "Border radius", confidence: 0.88, currentValue: "18px" },
      { key: "font-size", label: "Font size", confidence: 0.82, currentValue: "18px" },
      { key: "image", label: "Image", confidence: 0.9, currentValue: "/images/avatar-a.png" },
    ],
    editableCapabilities: [
      { key: "text", label: "Copy", confidence: 0.95 },
      { key: "spacing", label: "Spacing", confidence: 0.84 },
      { key: "radius", label: "Radius", confidence: 0.88 },
      { key: "typography", label: "Typography", confidence: 0.82 },
      { key: "image", label: "Image", confidence: 0.9 },
      { key: "visibility", label: "Visibility", confidence: 0.9 },
    ],
    payload: createSelection(),
    ...overrides,
  };
}

test("buildSelectionTarget prioritizes exact React source anchors", async () => {
  const projectDir = await createTempProject({
    "src/components/ProfileCard.tsx": `
      export function ProfileCard() {
        return (
          <article className="profile-card">
            <h3>Primary owner</h3>
          </article>
        );
      }
    `,
    "src/app/App.tsx": `
      import { ProfileCard } from "../components/ProfileCard";
      export default function App() {
        return <ProfileCard />;
      }
    `,
  });

  const selectionTarget = await buildSelectionTarget({
    projectDir,
    route: "/",
    currentFilePath: "src/app/App.tsx",
    selection: createSelection({
      sourceAnchor: {
        filePath: "/private/tmp/workspace/src/components/ProfileCard.tsx",
        line: 4,
        column: 11,
        componentName: "ProfileCard",
        ownerStack: ["DashboardPage", "ProfileCard"],
      },
    }),
    componentIndex: {
      generatedAt: new Date().toISOString(),
      projectFingerprint: "precision-test",
      components: [
        {
          name: "Profile Card",
          filePath: "src/components/ProfileCard.tsx",
          route: "/",
          kind: "component",
          keywords: ["profile", "card", "owner"],
        },
      ],
    } as never,
  });

  assert.ok(selectionTarget);
  assert.equal(selectionTarget?.sourceFilePath, "src/components/ProfileCard.tsx");
  assert.equal(selectionTarget?.resolutionMethod, "react-source-anchor");
  assert.equal(selectionTarget?.sourceCandidates[0]?.path, "src/components/ProfileCard.tsx");
});

test("collectContextGraph excerpts around the anchored source line", async () => {
  const anchoredFile = Array.from({ length: 920 }, (_, index) =>
    index === 617
      ? '  const headline = "Anchored line";'
      : `  const filler${index} = "line ${index + 1}";`,
  ).join("\n");
  const projectDir = await createTempProject({
    "src/components/ProfileCard.tsx": `export function ProfileCard() {\n${anchoredFile}\n  return <div />;\n}\n`,
    "src/app/App.tsx": "export default function App() { return null; }\n",
  });
  const selectionTarget = createSelectionTarget({
    sourceAnchor: {
      filePath: "src/components/ProfileCard.tsx",
      line: 618,
      column: 3,
      componentName: "ProfileCard",
      ownerStack: ["DashboardPage", "ProfileCard"],
    },
  });

  const context = await collectContextGraph({
    projectDir,
    route: "/",
    currentFilePath: "src/app/App.tsx",
    prompt: "Increase the spacing around the selected profile card.",
    selection: createSelection(),
    selectionTarget,
    kits: [],
    recentTurns: [],
    attachments: [],
  });

  const anchoredContext = context.contextFiles.find(
    (file) => file.path === "src/components/ProfileCard.tsx",
  );
  assert.ok(anchoredContext);
  assert.match(anchoredContext?.content || "", /MYMAKE SOURCE ANCHOR src\/components\/ProfileCard\.tsx:618:3/);
  assert.match(anchoredContext?.content || "", /Anchored line/);
});

test("buildEditPlan emits structured spacing operations with axis scope", () => {
  const selectionTarget = createSelectionTarget();
  const plan = buildEditPlan({
    currentFilePath: "src/components/ProfileCard.tsx",
    currentFileContent: "export function ProfileCard() { return null; }",
    prompt: "Tighten only the horizontal spacing on this card to 20px.",
    runtime: "vite",
    selectionTarget,
    contextGraph: {
      selectionTarget,
      contextFiles: [],
      sources: [],
      tokenBudget: 1000,
      compressedMemory: null,
      primaryTarget: selectionTarget.label,
      candidateFiles: ["src/components/ProfileCard.tsx"],
    },
    hasStaticEditableSupport: false,
    inspectorAction: {
      kind: "set-spacing",
      value: "20px",
      axis: "x",
    },
  });

  assert.equal(plan.lane, "deterministic");
  assert.equal(plan.uiOperations[0]?.kind, "setSpacing");
  assert.equal(plan.uiOperations[0]?.axis, "x");
  assert.equal(plan.uiOperations[0]?.sourceFileHint, "src/components/ProfileCard.tsx");
});

test("buildEditPlan promotes repeated text updates into repeated-item operations", () => {
  const selectionTarget = createSelectionTarget({
    scopeMode: "all-matching",
    repeatGroup: "profile-card",
  });
  const plan = buildEditPlan({
    currentFilePath: "src/components/ProfileCard.tsx",
    currentFileContent: "export function ProfileCard() { return null; }",
    prompt: 'Change this selected text to "Lead owner".',
    runtime: "vite",
    selectionTarget,
    contextGraph: {
      selectionTarget,
      contextFiles: [],
      sources: [],
      tokenBudget: 1000,
      compressedMemory: null,
      primaryTarget: selectionTarget.label,
      candidateFiles: ["src/components/ProfileCard.tsx"],
    },
    hasStaticEditableSupport: false,
    inspectorAction: {
      kind: "replace-text",
      value: "Lead owner",
    },
  });

  assert.ok(plan.uiOperations.some((operation) => operation.kind === "setText"));
  assert.ok(plan.uiOperations.some((operation) => operation.kind === "updateRepeatedItem"));
});

test("buildEditPlan emits swap-image and typography operations for inspector edits", () => {
  const selectionTarget = createSelectionTarget();
  const contextGraph = {
    selectionTarget,
    contextFiles: [],
    sources: [],
    tokenBudget: 1000,
    compressedMemory: null,
    primaryTarget: selectionTarget.label,
    candidateFiles: ["src/components/ProfileCard.tsx"],
  };

  const imagePlan = buildEditPlan({
    currentFilePath: "src/components/ProfileCard.tsx",
    currentFileContent: "export function ProfileCard() { return null; }",
    prompt: "Replace only the selected image.",
    runtime: "vite",
    selectionTarget,
    contextGraph,
    hasStaticEditableSupport: false,
    inspectorAction: {
      kind: "swap-image",
      value: "/images/avatar-b.png",
    },
  });

  const typographyPlan = buildEditPlan({
    currentFilePath: "src/components/ProfileCard.tsx",
    currentFileContent: "export function ProfileCard() { return null; }",
    prompt: "Set only the selected font size to 24px.",
    runtime: "vite",
    selectionTarget,
    contextGraph,
    hasStaticEditableSupport: false,
    inspectorAction: {
      kind: "set-size",
      value: "24px",
    },
  });

  assert.equal(imagePlan.uiOperations[0]?.kind, "swapImage");
  assert.equal(typographyPlan.uiOperations[0]?.kind, "setTypography");
});
