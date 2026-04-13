import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildEditPlan,
  buildSelectionTarget,
  type ContextGraphResult,
} from "@/lib/server/project-intelligence";
import type { SelectionPayload, SelectionTarget } from "@/lib/types";

async function createTempProject(structure: Record<string, string>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mymake-reliability-"));
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
    domPath: "div.card > svg > path:nth-of-type(1)",
    selector: ".stat-card svg path:nth-of-type(1)",
    scopeSelector: ".stat-card:nth-of-type(2)",
    scopedSelector: "svg path:nth-of-type(1)",
    nearestFramerName: "Offshore Card",
    framerPath: ["Dashboard", "Deposits Breakdown", "Offshore Card"],
    tagName: "path",
    textContent: "",
    attributes: {
      stroke: "#8b949e",
    },
    classes: ["stat-card", "sparkline"],
    outerHtml: '<path stroke="#8b949e" fill="none" />',
    boundingBox: { x: 0, y: 0, width: 240, height: 48 },
    role: null,
    href: null,
    src: null,
    editableProperties: ["line-color", "visibility", "layout"],
    fingerprint: "path::offshore-card::stroke",
    instanceScope: ".stat-card:nth-of-type(2)",
    contextTexts: ["Offshore", "Deposits", "$8.94M"],
    visualType: "chart-line",
    reactComponentStack: ["DepositCard", "DepositsBreakdown", "App"],
    reactSourceHints: ["DepositsBreakdown.tsx", "DepositCard", "Offshore"],
    ...overrides,
  };
}

function createContextGraph(candidateFiles: string[], selectionTarget: SelectionTarget | null): ContextGraphResult {
  return {
    selectionTarget,
    contextFiles: [],
    sources: [],
    tokenBudget: 1000,
    compressedMemory: null,
    primaryTarget: selectionTarget?.label || null,
    candidateFiles,
  };
}

test("buildSelectionTarget prefers the repeated card component over the page-level chart", async () => {
  const projectDir = await createTempProject({
    "src/app/components/TrendChart.tsx": `
      export function TrendChart() {
        return (
          <section>
            <h2>Trend Analysis</h2>
            <Line stroke="#34d399" />
            <Area fill="rgba(52, 211, 153, 0.2)" />
            <span>Transactions</span>
            <span>Revenue</span>
            <span>Spendings</span>
          </section>
        );
      }
    `,
    "src/app/components/StatCard.tsx": `
      export function StatCard() {
        return (
          <article className="stat-card">
            <h3>Offshore</h3>
            <p>Deposits</p>
            <strong>$8.94M</strong>
            <svg>
              <path stroke="#8b949e" fill="none" />
            </svg>
          </article>
        );
      }
    `,
    "src/app/App.tsx": `
      import { TrendChart } from "./components/TrendChart";
      import { StatCard } from "./components/StatCard";
      export default function App() {
        return (
          <>
            <TrendChart />
            <StatCard />
          </>
        );
      }
    `,
  });

  const selectionTarget = await buildSelectionTarget({
    projectDir,
    route: "/",
    currentFilePath: "src/app/App.tsx",
    selection: createSelection(),
    componentIndex: {
      generatedAt: new Date().toISOString(),
      projectFingerprint: "test",
      components: [
        {
          name: "Trend Chart",
          filePath: "src/app/components/TrendChart.tsx",
          route: "/",
          kind: "component",
          keywords: ["trend", "analysis", "transactions", "revenue", "spendings"],
        },
        {
          name: "Stat Card",
          filePath: "src/app/components/StatCard.tsx",
          route: "/",
          kind: "component",
          keywords: ["offshore", "deposits", "sparkline", "card"],
        },
      ],
    } as never,
  });

  assert.ok(selectionTarget);
  assert.equal(selectionTarget?.sourceFilePath, "src/app/components/StatCard.tsx");
  assert.ok((selectionTarget?.confidence || 0) >= 0.6);
  assert.equal(selectionTarget?.sourceCandidates[0]?.path, "src/app/components/StatCard.tsx");
});

test("buildSelectionTarget trusts React source hints over route-level chart guesses", async () => {
  const projectDir = await createTempProject({
    "src/app/components/TrendChart.tsx": `
      export function TrendChart() {
        return (
          <section>
            <h2>Trend Analysis</h2>
            <span>Transactions</span>
            <span>Revenue</span>
            <span>Spendings</span>
            <svg><path stroke="#8b949e" fill="none" /></svg>
          </section>
        );
      }
    `,
    "src/app/components/DepositsBreakdown.tsx": `
      export function DepositsBreakdown() {
        return (
          <section>
            <h2>Deposits Breakdown</h2>
            <article>
              <h3>Offshore</h3>
              <p>Deposits</p>
              <strong>$8.94M</strong>
              <svg><path stroke="#8b949e" fill="none" /></svg>
            </article>
          </section>
        );
      }
    `,
    "src/app/App.tsx": `
      import { TrendChart } from "./components/TrendChart";
      import { DepositsBreakdown } from "./components/DepositsBreakdown";
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

  const selectionTarget = await buildSelectionTarget({
    projectDir,
    route: "/",
    currentFilePath: "src/app/App.tsx",
    selection: createSelection({
      contextTexts: ["$260.2k"],
      reactComponentStack: ["DepositCard", "DepositsBreakdown", "App"],
      reactSourceHints: ["DepositsBreakdown.tsx", "DepositCard", "Offshore"],
    }),
    componentIndex: {
      generatedAt: new Date().toISOString(),
      projectFingerprint: "test",
      components: [
        {
          name: "Trend Chart",
          filePath: "src/app/components/TrendChart.tsx",
          route: "/",
          kind: "component",
          keywords: ["trend", "analysis", "transactions", "revenue", "spendings"],
        },
        {
          name: "Deposits Breakdown",
          filePath: "src/app/components/DepositsBreakdown.tsx",
          route: "/",
          kind: "component",
          keywords: ["offshore", "deposits", "breakdown", "sparkline", "card"],
        },
      ],
    } as never,
  });

  assert.ok(selectionTarget);
  assert.equal(selectionTarget?.sourceFilePath, "src/app/components/DepositsBreakdown.tsx");
  assert.ok((selectionTarget?.confidence || 0) >= 0.8);
});

test("buildEditPlan routes simple chart-line changes through the deterministic lane", async () => {
  const selectionTarget = {
    targetId: "target-1",
    fingerprint: "path::offshore-card::stroke",
    route: "/",
    label: "Offshore Card",
    summary: "Offshore / Deposits / $8.94M",
    sourceFilePath: "src/app/components/StatCard.tsx",
    sourceCandidates: [
      {
        path: "src/app/components/StatCard.tsx",
        score: 180,
        reason: "contains Offshore; contains current stroke value",
        matchedTerms: ["offshore", "deposits"],
      },
    ],
    confidence: 0.88,
    componentName: "Stat Card",
    sectionName: "Deposits Breakdown",
    repeatGroup: "Card",
    instanceScope: ".stat-card:nth-of-type(2)",
    visualType: "chart-line",
    resolvedHandles: [
      {
        key: "line-color",
        label: "Line color",
        confidence: 0.98,
        currentValue: "#8b949e",
      },
    ],
    editableCapabilities: [
      { key: "line-color", label: "Line color", confidence: 0.98 },
      { key: "visibility", label: "Visibility", confidence: 0.9 },
    ],
    payload: createSelection(),
  } satisfies SelectionTarget;

  const plan = buildEditPlan({
    currentFilePath: "src/app/components/StatCard.tsx",
    currentFileContent: '<path stroke="#8b949e" fill="none" />',
    prompt: "Make only this selected line red. Do not change the shaded area.",
    runtime: "vite",
    selectionTarget,
    contextGraph: createContextGraph(["src/app/components/StatCard.tsx"], selectionTarget),
    hasStaticEditableSupport: false,
  });

  assert.equal(plan.lane, "deterministic");
  assert.equal(plan.intent.kind, "set-line-color");
  assert.equal(plan.strategy, "direct-property");
  assert.equal(plan.allowedFiles[0], "src/app/components/StatCard.tsx");
  assert.ok(plan.allowedProperties.includes("line-color"));
  assert.equal(plan.requiresConfirmation, false);
});

test("buildEditPlan requires confirmation when target confidence is low", async () => {
  const selectionTarget = {
    targetId: "target-2",
    fingerprint: "low-confidence",
    route: "/",
    label: "Unknown Card",
    summary: "Selected card",
    sourceFilePath: "src/app/App.tsx",
    sourceCandidates: [
      {
        path: "src/app/App.tsx",
        score: 40,
        reason: "active editor file",
        matchedTerms: [],
      },
    ],
    confidence: 0.24,
    componentName: "App",
    sectionName: "Home",
    repeatGroup: null,
    instanceScope: null,
    visualType: "container",
    resolvedHandles: [{ key: "visibility", label: "Visibility", confidence: 0.9 }],
    editableCapabilities: [{ key: "visibility", label: "Visibility", confidence: 0.9 }],
    payload: createSelection({
      nearestFramerName: "Unknown Card",
      visualType: "container",
      editableProperties: ["visibility"],
    }),
  } satisfies SelectionTarget;

  const plan = buildEditPlan({
    currentFilePath: "src/app/App.tsx",
    currentFileContent: "<div />",
    prompt: "Change this to match the other card.",
    runtime: "vite",
    selectionTarget,
    contextGraph: createContextGraph(["src/app/App.tsx"], selectionTarget),
    hasStaticEditableSupport: false,
  });

  assert.equal(plan.requiresConfirmation, true);
  assert.equal(plan.lane, "deep-fix");
});
