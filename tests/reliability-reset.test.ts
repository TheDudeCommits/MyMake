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
import {
  debugApplyChartBarNormalizationEditForTest,
  debugApplyDirectionalTrendEditForTest,
} from "@/lib/server/project-service";
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

function createSelectionTarget(overrides: Partial<SelectionTarget>): SelectionTarget {
  return {
    targetId: "target",
    fingerprint: "selection-fingerprint",
    route: "/",
    label: "Selection",
    summary: "Selection summary",
    sourceFilePath: null,
    sourceCandidates: [],
    confidence: 0.5,
    componentName: null,
    sectionName: null,
    repeatGroup: null,
    instanceScope: null,
    instanceIndex: null,
    scopeMode: "instance",
    visualType: null,
    sourceAnchor: null,
    resolutionMethod: "heuristic-file-score",
    styleSnapshot: null,
    proofHandles: [],
    resolvedHandles: [],
    editableCapabilities: [],
    payload: createSelection(),
    ...overrides,
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
  const selectionTarget = createSelectionTarget({
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
  });

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

test("buildEditPlan routes directional chart-line prompts through the deterministic lane", async () => {
  const selectionTarget = createSelectionTarget({
    targetId: "target-3",
    fingerprint: "path::virtual-card::stroke",
    route: "/",
    label: "Virtual",
    summary: "Virtual / Deposits / $9.80M",
    sourceFilePath: "src/app/components/DepositsBreakdown.tsx",
    sourceCandidates: [
      {
        path: "src/app/components/DepositsBreakdown.tsx",
        score: 240,
        reason: "matches React source hint; contains \"Virtual\"; contains \"Deposits\"",
        matchedTerms: ["virtual", "deposits", "sparkline"],
      },
    ],
    confidence: 0.94,
    componentName: "Deposits Breakdown",
    sectionName: "Deposits Breakdown",
    repeatGroup: "Card",
    instanceScope: ".deposit-card:nth-of-type(1)",
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
    payload: createSelection({
      nearestFramerName: "Virtual",
      contextTexts: ["Virtual", "Deposits", "$9.80M", "Deposits Breakdown"],
      reactComponentStack: ["DepositCard", "DepositsBreakdown", "App"],
      reactSourceHints: ["DepositsBreakdown.tsx", "DepositCard", "Virtual"],
    }),
  });

  const plan = buildEditPlan({
    currentFilePath: "src/app/components/DepositsBreakdown.tsx",
    currentFileContent: "const UP_TREND_COLOR = '#8b949e'; const DOWN_TREND_COLOR = '#8b949e';",
    prompt:
      "Make all the downward trends red and all the upward ones green. But only color the lines themselves and not the shades below them.",
    runtime: "vite",
    selectionTarget,
    contextGraph: createContextGraph(["src/app/components/DepositsBreakdown.tsx"], selectionTarget),
    hasStaticEditableSupport: false,
  });

  assert.equal(plan.intent.kind, "set-directional-trend-colors");
  assert.equal(plan.lane, "deterministic");
  assert.equal(plan.strategy, "direct-property");
});

test("buildEditPlan routes bar-chart normalization prompts through the deterministic lane", async () => {
  const selectionTarget = createSelectionTarget({
    targetId: "target-bar-1",
    fingerprint: "rect::revenue-chart::bar",
    route: "/",
    label: "Revenue Overview",
    summary: "Revenue Overview / Monthly revenue breakdown / Dec",
    sourceFilePath: "src/app/components/RevenueChart.tsx",
    sourceCandidates: [
      {
        path: "src/app/components/RevenueChart.tsx",
        score: 226,
        reason: "matches React source hint; contains chart bar styling",
        matchedTerms: ["revenue", "bars", "chart"],
      },
    ],
    confidence: 0.94,
    componentName: "Revenue Chart",
    sectionName: "Revenue Overview",
    repeatGroup: "bar",
    instanceScope: ".recharts-bar-rectangles > rect:nth-of-type(12)",
    instanceIndex: 12,
    scopeMode: "instance",
    visualType: "chart-bar",
    resolvedHandles: [
      {
        key: "fill-color",
        label: "Fill color",
        confidence: 0.96,
        currentValue: "#d4183d",
      },
    ],
    editableCapabilities: [{ key: "fill-color", label: "Fill color", confidence: 0.96 }],
    payload: createSelection({
      tagName: "rect",
      selector: ".recharts-bar-rectangles > rect:nth-of-type(12)",
      scopeSelector: ".recharts-bar-rectangles",
      scopedSelector: "rect:nth-of-type(12)",
      attributes: { fill: "#d4183d" },
      editableProperties: ["fill-color", "visibility", "layout"],
      textContent: "",
      visualType: "chart-bar",
      contextTexts: ["Revenue Overview", "Monthly revenue breakdown", "Dec"],
      reactComponentStack: ["RevenueChart", "App"],
      reactSourceHints: ["RevenueChart.tsx", "RevenueChart"],
    }),
  });

  const plan = buildEditPlan({
    currentFilePath: "src/app/components/RevenueChart.tsx",
    currentFileContent: '<Cell fill={index === data.length - 1 ? "#d4183d" : fill} />',
    prompt: "Use the same subtle neutral colors for these bars and remove the red highlight.",
    runtime: "vite",
    selectionTarget,
    contextGraph: createContextGraph(["src/app/components/RevenueChart.tsx"], selectionTarget),
    hasStaticEditableSupport: false,
  });

  assert.equal(plan.intent.kind, "normalize-chart-bars");
  assert.equal(plan.lane, "deterministic");
  assert.equal(plan.strategy, "direct-property");
});

test("buildEditPlan still routes directional chart prompts deterministically when the selected region is a chart container", async () => {
  const selectionTarget = createSelectionTarget({
    targetId: "target-4",
    fingerprint: "div::virtual-card::sparkline-container",
    route: "/",
    label: "Virtual",
    summary: "Virtual / Deposits / $9.80M / Deposits Breakdown",
    sourceFilePath: "src/app/components/DepositsBreakdown.tsx",
    sourceCandidates: [
      {
        path: "src/app/components/DepositsBreakdown.tsx",
        score: 228,
        reason: "contains \"Virtual\"; contains \"Deposits\"; renders chart primitives directly",
        matchedTerms: ["virtual", "deposits", "sparkline", "chart"],
      },
    ],
    confidence: 0.9,
    componentName: "Deposits Breakdown",
    sectionName: "Deposits Breakdown",
    repeatGroup: "Card",
    instanceScope: ".deposit-card:nth-of-type(1)",
    visualType: "container",
    resolvedHandles: [
      {
        key: "line-color",
        label: "Line color",
        confidence: 0.93,
        currentValue: "#8b949e",
      },
      {
        key: "visibility",
        label: "Visibility",
        confidence: 0.9,
        currentValue: null,
      },
    ],
    editableCapabilities: [
      { key: "line-color", label: "Line color", confidence: 0.93 },
      { key: "visibility", label: "Visibility", confidence: 0.9 },
    ],
    payload: createSelection({
      tagName: "div",
      visualType: "container",
      attributes: { stroke: "#8b949e" },
      editableProperties: ["line-color", "visibility", "layout"],
      reactComponentStack: [],
      reactSourceHints: [],
    }),
  });

  const plan = buildEditPlan({
    currentFilePath: "src/app/components/DepositsBreakdown.tsx",
    currentFileContent: "const UP_TREND_COLOR = '#8b949e'; const DOWN_TREND_COLOR = '#8b949e';",
    prompt: "Downward movements should be red, only upward movements green.",
    runtime: "vite",
    selectionTarget,
    contextGraph: createContextGraph(["src/app/components/DepositsBreakdown.tsx"], selectionTarget),
    hasStaticEditableSupport: false,
  });

  assert.equal(plan.intent.kind, "set-directional-trend-colors");
  assert.equal(plan.lane, "deterministic");
});

test("buildEditPlan requires confirmation when target confidence is low", async () => {
  const selectionTarget = createSelectionTarget({
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
  });

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

test("directional trend deterministic edits can target a repeated instance by index without needing a label", async () => {
  const projectDir = await createTempProject({
    "src/app/components/DepositsBreakdown.tsx": `
      const UP_TREND_COLOR = "#8b949e";
      const DOWN_TREND_COLOR = "#8b949e";

      type TrendSegment = {
        color: string;
        gradientId: string;
      };

      type DepositCardProps = {
        label: string;
        accent?: boolean;
        delay?: number;
      };

      function buildDirectionalSegments(
        chartData: Array<{ value: number }>,
        gradientPrefix: string,
      ): TrendSegment[] {
        const first = chartData[0]?.value ?? 0;
        const last = chartData.at(-1)?.value ?? first;
        const isUpTrend = last >= first;
        const color = isUpTrend ? UP_TREND_COLOR : DOWN_TREND_COLOR;
        return [{ color, gradientId: gradientPrefix }];
      }

      function DepositCard({
        label,
        accent = false,
        delay = 0,
      }: DepositCardProps) {
        const chartData = [{ value: 1 }, { value: 2 }];
        const gradientId = label.toLowerCase();
        const segments = buildDirectionalSegments(chartData, gradientId);
        return (
          <article className="deposit-card">
            <h3>{label}</h3>
            <svg>
              {segments.map((segment) => (
                <linearGradient key={segment.gradientId}>
                  <stop stopColor={segment.color} stopOpacity={0.2} />
                </linearGradient>
              ))}
            </svg>
          </article>
        );
      }

      export function DepositsBreakdown() {
        return (
          <section>
            <DepositCard label="Virtual" />
            <DepositCard label="Offshore" />
          </section>
        );
      }
    `,
  });

  const result = await debugApplyDirectionalTrendEditForTest({
    projectDir,
    allowedFiles: ["src/app/components/DepositsBreakdown.tsx"],
    intent: {
      kind: "set-directional-trend-colors",
      confidence: 0.95,
      summary: "Color only this selected sparkline by direction.",
      target: "Virtual sparkline",
      requestedValue: JSON.stringify({
        upColor: "#22c55e",
        downColor: "#ef4444",
        lineOnly: true,
      }),
      parameters: {
        upColor: "#22c55e",
        downColor: "#ef4444",
        lineOnly: true,
      },
    },
    selectionTarget: createSelectionTarget({
      targetId: "target-5",
      fingerprint: "path::virtual-card::stroke",
      route: "/",
      label: "",
      summary: "Selected repeated sparkline instance",
      sourceFilePath: "src/app/components/DepositsBreakdown.tsx",
      sourceCandidates: [
        {
          path: "src/app/components/DepositsBreakdown.tsx",
          score: 245,
          reason: "matches repeated sparkline component",
          matchedTerms: ["deposits", "sparkline", "virtual"],
        },
      ],
      confidence: 0.93,
      componentName: "Deposits Breakdown",
      sectionName: "Deposits Breakdown",
      repeatGroup: "deposit-card",
      instanceScope: ".deposit-card:nth-of-type(1)",
      instanceIndex: 1,
      scopeMode: "instance",
      visualType: "chart-line",
      resolvedHandles: [
        {
          key: "line-color",
          label: "Line color",
          confidence: 0.97,
          currentValue: "#8b949e",
        },
      ],
      editableCapabilities: [{ key: "line-color", label: "Line color", confidence: 0.97 }],
      payload: createSelection({
        nearestFramerName: null,
        contextTexts: ["Deposits", "$9.80M"],
        instanceIndex: 1,
        repeatKey: "deposit-card",
      }),
    }),
  });

  assert.ok(result);
  assert.equal(result?.changedFiles[0]?.path, "src/app/components/DepositsBreakdown.tsx");
  assert.match(result?.summary || "", /selected instance #1/i);
  assert.match(result?.changedFiles[0]?.content || "", /<DepositCard label="Virtual"[\s\S]*upTrendColor="#22c55e"/);
  assert.doesNotMatch(result?.changedFiles[0]?.content || "", /<DepositCard label="Offshore"[\s\S]*upTrendColor="#22c55e"/);
});

test("directional trend deterministic edits support inline DepositCard trendColor logic from production projects", async () => {
  const projectDir = await createTempProject({
    "src/app/components/DepositsBreakdown.tsx": `
      interface DepositCardProps {
        label: string;
        lineColor: string;
        gradientId: string;
        accent?: boolean;
        delay?: number;
      }

      function DepositCard({
        label,
        lineColor,
        gradientId,
        accent = false,
        delay = 0,
      }: DepositCardProps) {
        const first = 10;
        const last = 8;
        const isUpward = last >= first;
        const trendColor = isUpward ? "#22c55e" : "#d4183d";

        return (
          <article className="deposit-card">
            <svg>
              <defs>
                <linearGradient id={gradientId}>
                  <stop offset="0%" stopColor={lineColor} stopOpacity={0.18} />
                  <stop offset="100%" stopColor={lineColor} stopOpacity={0} />
                </linearGradient>
              </defs>
              <path stroke={trendColor} />
            </svg>
          </article>
        );
      }

      export function DepositsBreakdown() {
        return (
          <section>
            <DepositCard
              label="Virtual"
              lineColor="#e5e5e5"
              gradientId="spark-virtual"
              accent
              delay={0.65}
            />
            <DepositCard
              label="Offshore"
              lineColor="#888"
              gradientId="spark-offshore"
              delay={0.72}
            />
          </section>
        );
      }
    `,
  });

  const result = await debugApplyDirectionalTrendEditForTest({
    projectDir,
    allowedFiles: ["src/app/components/DepositsBreakdown.tsx"],
    intent: {
      kind: "set-directional-trend-colors",
      confidence: 0.95,
      summary: "Color only this selected sparkline by direction.",
      target: "Virtual sparkline",
      requestedValue: JSON.stringify({
        upColor: "#22c55e",
        downColor: "#ef4444",
        lineOnly: true,
      }),
      parameters: {
        upColor: "#22c55e",
        downColor: "#ef4444",
        lineOnly: true,
      },
    },
    selectionTarget: createSelectionTarget({
      targetId: "target-6",
      fingerprint: "path::virtual-card::stroke",
      route: "/",
      label: "",
      summary: "Selected repeated sparkline instance",
      sourceFilePath: "src/app/components/DepositsBreakdown.tsx",
      sourceCandidates: [
        {
          path: "src/app/components/DepositsBreakdown.tsx",
          score: 245,
          reason: "matches repeated sparkline component",
          matchedTerms: ["deposits", "sparkline", "virtual"],
        },
      ],
      confidence: 0.93,
      componentName: "Deposits Breakdown",
      sectionName: "Deposits Breakdown",
      repeatGroup: "deposit-card",
      instanceScope: ".deposit-card:nth-of-type(1)",
      instanceIndex: 1,
      scopeMode: "instance",
      visualType: "chart-line",
      resolvedHandles: [
        {
          key: "line-color",
          label: "Line color",
          confidence: 0.97,
          currentValue: "#8b949e",
        },
      ],
      editableCapabilities: [{ key: "line-color", label: "Line color", confidence: 0.97 }],
      payload: createSelection({
        nearestFramerName: null,
        contextTexts: ["Deposits", "$9.80M"],
        instanceIndex: 1,
        repeatKey: "deposit-card",
      }),
    }),
  });

  assert.ok(result);
  assert.match(result?.changedFiles[0]?.content || "", /const trendColor = isUpward \? upTrendColor : downTrendColor;/);
  assert.match(result?.changedFiles[0]?.content || "", /<DepositCard[\s\S]*label="Virtual"[\s\S]*upTrendColor="#22c55e"[\s\S]*downTrendColor="#ef4444"/);
  assert.doesNotMatch(result?.changedFiles[0]?.content || "", /<DepositCard[\s\S]*label="Offshore"[\s\S]*upTrendColor="#22c55e"/);
});

test("chart bar normalization removes a one-off highlighted last bar while keeping the neutral palette", async () => {
  const projectDir = await createTempProject({
    "src/app/components/RevenueChart.tsx": `
      export function RevenueChart({ data }: { data: Array<{ revenue: number }> }) {
        const maxRevenue = Math.max(...data.map((d) => d.revenue || 0), 1);
        return (
          <Bar dataKey="revenue" radius={[4, 4, 0, 0]}>
            {data.map((entry, index) => {
              const isLast = index === data.length - 1;

              if (isLast) {
                return <Cell key={\`cell-\${index}\`} fill="#d4183d" />;
              }

              const ratio = (entry.revenue || 0) / maxRevenue;
              const fill = mixHex("#2a2a2a", "#cbced4", ratio * 0.6);

              return <Cell key={\`cell-\${index}\`} fill={fill} />;
            })}
          </Bar>
        );
      }
    `,
  });

  const result = await debugApplyChartBarNormalizationEditForTest({
    projectDir,
    allowedFiles: ["src/app/components/RevenueChart.tsx"],
    intent: {
      kind: "normalize-chart-bars",
      confidence: 0.95,
      requestedValue: JSON.stringify({
        removeColor: "#d4183d",
        preferNeutralPalette: true,
      }),
      summary: "Normalize the selected revenue bars and remove the highlighted accent bar.",
    },
    selectionTarget: createSelectionTarget({
      targetId: "target-bar-2",
      fingerprint: "rect::revenue-chart::bar",
      route: "/",
      label: "Revenue Overview",
      summary: "Revenue Overview / Monthly revenue breakdown / Dec",
      sourceFilePath: "src/app/components/RevenueChart.tsx",
      sourceCandidates: [
        {
          path: "src/app/components/RevenueChart.tsx",
          score: 226,
          reason: "contains chart bar styling",
          matchedTerms: ["revenue", "bars", "chart"],
        },
      ],
      confidence: 0.94,
      componentName: "Revenue Chart",
      sectionName: "Revenue Overview",
      repeatGroup: "bar",
      instanceScope: ".recharts-bar-rectangles > rect:nth-of-type(12)",
      instanceIndex: 12,
      scopeMode: "instance",
      visualType: "chart-bar",
      resolvedHandles: [
        {
          key: "fill-color",
          label: "Fill color",
          confidence: 0.96,
          currentValue: "#d4183d",
        },
      ],
      editableCapabilities: [{ key: "fill-color", label: "Fill color", confidence: 0.96 }],
      payload: createSelection({
        tagName: "rect",
        selector: ".recharts-bar-rectangles > rect:nth-of-type(12)",
        scopeSelector: ".recharts-bar-rectangles",
        scopedSelector: "rect:nth-of-type(12)",
        attributes: { fill: "#d4183d" },
        editableProperties: ["fill-color", "visibility", "layout"],
        textContent: "",
        visualType: "chart-bar",
        contextTexts: ["Revenue Overview", "Monthly revenue breakdown", "Dec"],
      }),
    }),
  });

  assert.ok(result);
  assert.equal(result?.changedFiles[0]?.path, "src/app/components/RevenueChart.tsx");
  assert.doesNotMatch(result?.changedFiles[0]?.content || "", /if \(isLast\)/);
  assert.doesNotMatch(result?.changedFiles[0]?.content || "", /fill="#d4183d"/);
  assert.match(result?.changedFiles[0]?.content || "", /const fill = mixHex/);
  assert.match(result?.changedFiles[0]?.content || "", /return <Cell key=\{`cell-\$\{index\}`\} fill=\{fill\} \/>/);
});
