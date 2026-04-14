import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildEditPlan,
  buildSelectionTarget,
} from "@/lib/server/project-intelligence";
import type { SelectionPayload, SelectionTarget } from "@/lib/types";

async function createTempProject(structure: Record<string, string>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mymake-bench-"));
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

function createSelectionTarget(overrides?: Partial<SelectionTarget>): SelectionTarget {
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

function contextGraph(selectionTarget: SelectionTarget) {
  return {
    selectionTarget,
    contextFiles: [],
    sources: [],
    tokenBudget: 1000,
    compressedMemory: null,
    primaryTarget: selectionTarget.label,
    candidateFiles: [selectionTarget.sourceFilePath || "src/components/ProfileCard.tsx"],
  };
}

async function runBenchmarks() {
  const checks: Array<{ name: string; category: "selection" | "deterministic" | "ui-ops"; passed: boolean }> = [];

  const anchorProjectDir = await createTempProject({
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
  const anchorTarget = await buildSelectionTarget({
    projectDir: anchorProjectDir,
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
      projectFingerprint: "benchmark-selection-anchor",
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
  checks.push({
    name: "selection-react-source-anchor",
    category: "selection",
    passed:
      anchorTarget?.sourceFilePath === "src/components/ProfileCard.tsx" &&
      anchorTarget?.resolutionMethod === "react-source-anchor",
  });

  const hintsProjectDir = await createTempProject({
    "src/components/TrendChart.tsx": `
      export function TrendChart() {
        return <section><h2>Trend Analysis</h2><svg><path stroke="#8b949e" /></svg></section>;
      }
    `,
    "src/components/DepositsBreakdown.tsx": `
      export function DepositsBreakdown() {
        return (
          <section>
            <article className="deposit-card">
              <h3>Offshore</h3>
              <p>Deposits</p>
              <svg><path stroke="#8b949e" /></svg>
            </article>
          </section>
        );
      }
    `,
    "src/app/App.tsx": `
      import { TrendChart } from "../components/TrendChart";
      import { DepositsBreakdown } from "../components/DepositsBreakdown";
      export default function App() {
        return (
          <>
            <TrendChart />
            <DepositsBreakdown />
          </>
        );
      }
    `,
  });
  const hintsTarget = await buildSelectionTarget({
    projectDir: hintsProjectDir,
    route: "/",
    currentFilePath: "src/app/App.tsx",
    selection: createSelection({
      reactComponentStack: ["DepositCard", "DepositsBreakdown", "App"],
      reactSourceHints: ["DepositsBreakdown.tsx", "DepositCard", "Offshore"],
      contextTexts: ["Offshore", "Deposits", "$8.94M"],
    }),
    componentIndex: {
      generatedAt: new Date().toISOString(),
      projectFingerprint: "benchmark-selection-hints",
      components: [
        {
          name: "Trend Chart",
          filePath: "src/components/TrendChart.tsx",
          route: "/",
          kind: "component",
          keywords: ["trend", "analysis"],
        },
        {
          name: "Deposits Breakdown",
          filePath: "src/components/DepositsBreakdown.tsx",
          route: "/",
          kind: "component",
          keywords: ["deposits", "offshore", "card"],
        },
      ],
    } as never,
  });
  checks.push({
    name: "selection-react-source-hints",
    category: "selection",
    passed:
      hintsTarget?.sourceFilePath === "src/components/DepositsBreakdown.tsx" &&
      hintsTarget?.resolutionMethod === "react-source-hints",
  });

  const baseTarget = createSelectionTarget();
  const spacingPlan = buildEditPlan({
    currentFilePath: "src/components/ProfileCard.tsx",
    currentFileContent: "export function ProfileCard() { return null; }",
    prompt: "Tighten only the horizontal spacing on this card to 20px.",
    runtime: "vite",
    selectionTarget: baseTarget,
    contextGraph: contextGraph(baseTarget),
    hasStaticEditableSupport: false,
    inspectorAction: {
      kind: "set-spacing",
      value: "20px",
      axis: "x",
    },
  });
  checks.push({
    name: "deterministic-spacing-lane",
    category: "deterministic",
    passed: spacingPlan.lane === "deterministic",
  });
  checks.push({
    name: "ui-operation-spacing-axis",
    category: "ui-ops",
    passed: spacingPlan.uiOperations[0]?.kind === "setSpacing" && spacingPlan.uiOperations[0]?.axis === "x",
  });

  const repeatTarget = createSelectionTarget({ scopeMode: "all-matching" });
  const repeatPlan = buildEditPlan({
    currentFilePath: "src/components/ProfileCard.tsx",
    currentFileContent: "export function ProfileCard() { return null; }",
    prompt: 'Change this selected text to "Lead owner".',
    runtime: "vite",
    selectionTarget: repeatTarget,
    contextGraph: contextGraph(repeatTarget),
    hasStaticEditableSupport: false,
    inspectorAction: {
      kind: "replace-text",
      value: "Lead owner",
    },
  });
  checks.push({
    name: "deterministic-repeat-text-lane",
    category: "deterministic",
    passed: repeatPlan.lane === "deterministic",
  });
  checks.push({
    name: "ui-operation-repeat-update",
    category: "ui-ops",
    passed: repeatPlan.uiOperations.some((operation) => operation.kind === "updateRepeatedItem"),
  });

  const imagePlan = buildEditPlan({
    currentFilePath: "src/components/ProfileCard.tsx",
    currentFileContent: "export function ProfileCard() { return null; }",
    prompt: "Replace the selected image source.",
    runtime: "vite",
    selectionTarget: baseTarget,
    contextGraph: contextGraph(baseTarget),
    hasStaticEditableSupport: false,
    inspectorAction: {
      kind: "swap-image",
      value: "/images/avatar-b.png",
    },
  });
  checks.push({
    name: "ui-operation-image-swap",
    category: "ui-ops",
    passed: imagePlan.uiOperations[0]?.kind === "swapImage",
  });

  const metrics = {
    selectionAccuracy:
      checks.filter((check) => check.category === "selection" && check.passed).length /
      Math.max(1, checks.filter((check) => check.category === "selection").length),
    deterministicCoverage:
      checks.filter((check) => check.category === "deterministic" && check.passed).length /
      Math.max(1, checks.filter((check) => check.category === "deterministic").length),
    structuredOperationCoverage:
      checks.filter((check) => check.category === "ui-ops" && check.passed).length /
      Math.max(1, checks.filter((check) => check.category === "ui-ops").length),
  };
  const thresholds = {
    selectionAccuracy: 0.95,
    deterministicCoverage: 0.95,
    structuredOperationCoverage: 0.95,
  };
  const failedThresholds = Object.entries(thresholds).filter(
    ([key, threshold]) => metrics[key as keyof typeof metrics] < threshold,
  );

  console.log(JSON.stringify({ metrics, thresholds, checks }, null, 2));

  if (failedThresholds.length) {
    console.error(
      `Benchmark thresholds failed: ${failedThresholds
        .map(([key, threshold]) => `${key} < ${threshold}`)
        .join(", ")}`,
    );
    process.exitCode = 1;
  }
}

void runBenchmarks();
