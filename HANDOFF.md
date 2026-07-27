# MyMake Handoff

Last updated: 2026-04-14
Repo: [TheDudeCommits/MyMake](https://github.com/TheDudeCommits/MyMake)
Production: [web-production-99795.up.railway.app](https://web-production-99795.up.railway.app)

## 1. What MyMake Is

MyMake is a Privy-authenticated AI-powered UI editor for frontend projects. It is designed to let a user:

- upload a frontend project as a zip
- preview it live inside the app
- click real elements in the rendered UI
- ask AI to edit those elements
- keep revision history and restore checkpoints
- export code
- optionally connect a GitHub repo
- optionally use a local Codex bridge for deeper edits

The current product is strongest as a code-first editor for uploaded frontend projects. It is not yet a fully mature Figma Make replacement, but it now has many of the primitives needed to become one.

## 2. Core Product Surface

### Home / Dashboard

- Per-user project dashboard
- Upload project zip
- GitHub connect/import entry points
- Project cards
- Project deletion
- Public published previews

### Workspace

- Left rail:
  - conversation / checkpoint journal
  - selected element details
  - context graph summaries
  - validation / error details
- Center canvas:
  - same-origin proxied live preview
  - device presets
  - element picker
- Composer:
  - prompt input
  - attachment support
  - model picker: `GPT 5.2`, `Sonnet 4.6`, `Codex`
- Inspector behavior:
  - selected target details
  - instance-vs-all-matching scope controls for repeated elements
  - lane previews and selection-aware editing hints

### Share / Export / Publish

- Export current revision as a zip
- Publish project as a public full-screen preview route

## 3. Supported Project Types

### Currently supported

- Next.js frontend projects
- Vite React frontend projects
- Framer/static export-style frontend projects

### Explicitly not strong yet

- monorepos and complex workspace repos
- backend-dependent applications
- multi-service apps
- projects that require external infra to boot

## 4. Authentication and User Ownership

### Current auth

- Privy is the app auth layer
- Per-user ownership now exists for:
  - projects
  - revisions
  - conversation history
  - attachments
  - GitHub connections

### Important env vars

- `NEXT_PUBLIC_PRIVY_APP_ID`
- `PRIVY_APP_SECRET`
- `PRIMARY_OWNER_EMAIL`
- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`
- `STORAGE_ROOT`
- `SQLITE_DB_PATH`

### Important note

Legacy projects were originally created before per-user ownership. A migration path exists to claim legacy data for the primary owner email on first login.

## 5. GitHub Integration

### Current capabilities

- connect a user’s GitHub account through OAuth
- import repos into MyMake
- connect existing MyMake projects to existing repos
- create a new repo from an existing MyMake project
- push the current project state to the connected repo

### Important behavior

Each MyMake user is intended to connect their own GitHub account. This is no longer a shared app-wide GitHub session.

## 6. Local Codex Bridge

MyMake supports a local Codex mode through a bridge that runs on the user’s Mac.

### What it is

- A local bridge server that MyMake talks to on `127.0.0.1`
- Keeps a persistent Codex session per project
- Lets MyMake send project workspaces to the local Codex runtime
- Lets the user open the exact Codex session for a project

### Important files

- [/Users/amir/Downloads/MyMake/scripts/codex-bridge.ts](./scripts/codex-bridge.ts)
- [/Users/amir/Downloads/MyMake/components/workspace-app.tsx](./components/workspace-app.tsx)
- [/Users/amir/Downloads/MyMake/app/api/projects/[projectId]/codex/apply/route.ts](./app/api/projects/[projectId]/codex/apply/route.ts)

### Local run

Safer startup command:

```bash
npm --prefix /Users/amir/Downloads/MyMake run codex-bridge
```

### Current limitations

- This is not OAuth into the Codex desktop UI
- It is a local bridge to the Codex runtime/CLI side
- It works only when the bridge is running on the same machine as the user’s MyMake session

## 7. Live Preview System

### Architecture

- MyMake runs a custom Node/Express server
- Uploaded projects are extracted to persistent storage
- A preview runner is spawned per project/runtime
- Preview content is proxied through MyMake so the iframe stays same-origin
- A preview bridge script is injected into the preview document

### Runtimes

- Next.js preview runner
- Vite preview runner
- static preview runner

### Important files

- [/Users/amir/Downloads/MyMake/server.ts](./server.ts)
- [/Users/amir/Downloads/MyMake/lib/server/preview-manager.ts](./lib/server/preview-manager.ts)
- [/Users/amir/Downloads/MyMake/scripts/project-preview-runner.ts](./scripts/project-preview-runner.ts)
- [/Users/amir/Downloads/MyMake/scripts/project-vite-preview-runner.ts](./scripts/project-vite-preview-runner.ts)
- [/Users/amir/Downloads/MyMake/scripts/project-static-preview-runner.ts](./scripts/project-static-preview-runner.ts)

### Major preview features already implemented

- warm runner retention
- reconnect/warmup handling
- same-origin iframe proxy
- project-level preview error isolation
- public preview routes for published projects

## 8. Element Selection and Code Correlation

This is the most important problem area in the product.

### Current architecture

The selection system now includes:

- runtime selection payloads from the preview bridge
- richer metadata:
  - `fingerprint`
  - `instanceScope`
  - `instanceIndex`
  - `repeatKey`
  - `allInstanceSelector`
  - `contextTexts`
  - `visualType`
  - React component stack hints
  - React source hints
- source candidate ranking
- confidence-based routing
- `instance` vs `all-matching` selection scope

### Current direction

The app has moved away from fuzzy file guessing toward:

- repeated-instance aware targeting
- deterministic edits when confidence is high
- constrained AI edits when confidence is medium
- deep-fix / Codex fallback when deterministic or scoped AI cannot safely complete the task

### Important files

- [/Users/amir/Downloads/MyMake/lib/server/preview-bridge.ts](./lib/server/preview-bridge.ts)
- [/Users/amir/Downloads/MyMake/lib/server/project-intelligence.ts](./lib/server/project-intelligence.ts)
- [/Users/amir/Downloads/MyMake/lib/server/project-service.ts](./lib/server/project-service.ts)
- [/Users/amir/Downloads/MyMake/lib/types.ts](./lib/types.ts)

### What improved recently

- repeated chart/card selections resolve better to instance-level source files
- React source hints are used to rank candidate files
- route-level wrappers like `App.tsx` are deprioritized when child components clearly own the selected UI
- chart primitives are being normalized into more semantic types like:
  - `chart-line`
  - `chart-area`
  - `chart-bar`

## 9. AI Editing Architecture

### Current model options

- `GPT 5.2`
- `Sonnet 4.6`
- `Codex`

### Current high-level edit lanes

- `deterministic`
- `scoped-ai`
- `deep-fix`

### Deterministic lane

Used for simpler, high-confidence edits where MyMake can avoid broad model rewrites.

Examples:

- direct text replacement
- line color changes
- directional trend chart changes
- chart bar normalization
- simple fill/background replacements

### Scoped AI lane

Used when the app can resolve a target and a limited set of files, but needs model help to express the change.

### Deep-fix lane

Used when:

- deterministic execution cannot express the edit
- scoped AI fails validation
- a harder retry path is needed

Codex is intended to be the strongest fallback path here.

### Important files

- [/Users/amir/Downloads/MyMake/lib/server/ai.ts](./lib/server/ai.ts)
- [/Users/amir/Downloads/MyMake/lib/server/openai.ts](./lib/server/openai.ts)
- [/Users/amir/Downloads/MyMake/lib/server/anthropic.ts](./lib/server/anthropic.ts)
- [/Users/amir/Downloads/MyMake/lib/server/project-service.ts](./lib/server/project-service.ts)

## 10. Conversation, Context, and Memory

The app has a richer context stack than it started with.

### Current subsystems

- context graph
- project memory files
- guideline routing
- bounded conversation history
- context window manager
- attachment processing

### Key files

- [/Users/amir/Downloads/MyMake/lib/server/ai-context.ts](./lib/server/ai-context.ts)
- [/Users/amir/Downloads/MyMake/lib/server/conversation-history.ts](./lib/server/conversation-history.ts)
- [/Users/amir/Downloads/MyMake/lib/server/guidelines.ts](./lib/server/guidelines.ts)
- [/Users/amir/Downloads/MyMake/lib/server/attachment-manager.ts](./lib/server/attachment-manager.ts)
- [/Users/amir/Downloads/MyMake/lib/server/project-intelligence.ts](./lib/server/project-intelligence.ts)

### Internal project knowledge files

These are stored under `.mymake` inside project workspaces:

- `project_brief.md`
- `design_rules.md`
- `brand_kit.json`
- `component_index.json`
- `edit_memory.json`
- `project-memory.md`

### Important reality check

These context systems are useful, but they are not the main blocker anymore. The biggest reliability gap remains target resolution and target-aware validation.

## 11. Checkpoints, Revisions, and Validation

### Checkpoints

Each edit creates a revision/checkpoint system with:

- summary
- changed files
- conversation turn association
- restore support

### Validation system

The app validates more than just “did the file compile?”

It now tries to answer:

- did the intended target change?
- did the edit stay within the resolved file scope?
- did nearby scope remain constrained?
- did runtime health remain okay?

### Known issue

This validation layer still sometimes rejects valid scoped edits because proof logic is too narrow for some UI patterns. This has improved, but it is still the main source of “it changed the right file, then rolled it back anyway.”

### Important file

- [/Users/amir/Downloads/MyMake/lib/server/project-service.ts](./lib/server/project-service.ts)

## 12. Figma-Focused Subsystems

The codebase now contains a substantial Figma pipeline foundation, even though the app is still primarily a code-project editor.

### Implemented modules

- design context serializer
- guideline store/router/generator
- conversation history manager
- design state tracker
- prompt assembler
- operation graph / compiler / validator / AI parser
- attachment pipeline with Figma support
- top-level Figma orchestration layer

### Important files

- [/Users/amir/Downloads/MyMake/lib/figma/design-context-serializer.ts](./lib/figma/design-context-serializer.ts)
- [/Users/amir/Downloads/MyMake/lib/figma/operation-translation.ts](./lib/figma/operation-translation.ts)
- [/Users/amir/Downloads/MyMake/lib/server/figma-make-clone.ts](./lib/server/figma-make-clone.ts)

### Important reality check

These modules are foundational and real, but the app is not yet a finished in-product Figma editor. They are best thought of as the groundwork for future Figma-native integration and shared targeting/execution logic.

## 13. Database and Persistence

### Persistence layers

- SQLite for structured app state
- filesystem snapshots for project revisions
- extracted working trees under persistent storage

### Important files

- [/Users/amir/Downloads/MyMake/lib/server/db.ts](./lib/server/db.ts)
- [/Users/amir/Downloads/MyMake/lib/server/storage.ts](./lib/server/project-service.ts)

### Stored objects

- users
- projects
- revisions
- conversation turns
- attachments
- validation records
- telemetry records
- GitHub bindings
- context snapshots
- make kits

## 14. Current Strengths

The app is meaningfully better than where it started.

### What works relatively well now

- user authentication through Privy
- project upload and persistence
- live preview booting for supported frontend apps
- project export
- GitHub connect/import/push basics
- revision history and restore
- same-origin preview selection infrastructure
- richer context/memory/guideline pipeline
- deterministic handling for some repeated chart-line edits
- local Codex bridge support

## 15. Current Weaknesses

This is the most important section for a handoff.

### Biggest current product problems

1. Target proof still fails too often
The app sometimes changes the correct file but cannot prove the intended target changed, so it rolls back valid edits.

2. Deterministic coverage is still too narrow
Some UI patterns have dedicated deterministic handlers, but not enough of them. The product still falls back to model-driven edits too early.

3. Selection-to-code correlation is improved but still incomplete
Repeated instances, SVG primitives, charts, and delegated component trees remain the hardest category.

4. The UX still feels inconsistent
Sometimes edits work quickly, then the next edit on a similar element fails for structural reasons the user cannot predict.

5. Codex local mode is powerful but still operationally awkward
It depends on a local bridge, and it is not truly “inside Codex app” in a user-visible native sense.

## 16. Most Recent Reliability Work

The latest active effort has been on reliability rather than adding more surface area.

### Recent direction

- improved `SelectionTarget` / `SelectionTargetV2`-style data
- instance-vs-all-matching scope handling
- deterministic trend-line edits
- target-aware validation
- chart primitive detection improvements
- direct production verification against Railway instead of trusting local-only fixes

### Latest verified production fix

The latest fix deployed and verified in production added a dedicated `normalize-chart-bars` deterministic path for the `RevenueChart` / highlighted-last-bar issue.

What it fixes:

- prompts like “remove the red highlight and make these bars use the same neutral palette”
- chart bar selection now resolves more semantically as `chart-bar`
- deterministic normalizer removes the one-off highlighted last bar case
- validator now proves the intended result based on structural bar-chart logic, not the wrong generic color check

Verified live:

- production container contains:
  - `normalize-chart-bars`
  - `chart-bar`
  - `tryApplyChartBarNormalizationEdit`
- the exact live `RevenueChart.tsx` content from the production project was pulled and tested against the deterministic helper
- result was:
  - `ok: true`
  - `removedRed: true`
  - `removedIsLast: true`

Latest verified commit:

- `6194bf6`

## 17. Recommended Immediate Priorities

If a new AI session takes over, this is the best next sequence.

### Priority 1
Expand deterministic edit coverage for common UI changes:

- bar chart color/gradient updates
- pie/donut segment recolors
- card background/border updates
- repeated list/grid item text/style edits
- image swap flows

### Priority 2
Strengthen target-aware validation:

- validate against runtime-selected instance fingerprints
- compare before/after scoped element properties
- reduce false rollbacks

### Priority 3
Improve the inspector so common edits do not require prompt parsing:

- text
- fill
- stroke
- opacity
- radius
- spacing
- visibility

### Priority 4
Build an explicit regression benchmark page / dataset and make it the release gate.

### Priority 5
Only after reliability improves:

- deepen Figma-native integration
- improve the creative redesign workflow
- improve Codex operational UX

## 18. Practical Resume Guide for the Next AI Session

If another session takes over, it should start here:

1. Read this file.
2. Read [README.md](./README.md).
3. Read the main execution stack:
   - [/Users/amir/Downloads/MyMake/lib/server/project-intelligence.ts](./lib/server/project-intelligence.ts)
   - [/Users/amir/Downloads/MyMake/lib/server/project-service.ts](./lib/server/project-service.ts)
   - [/Users/amir/Downloads/MyMake/lib/server/preview-bridge.ts](./lib/server/preview-bridge.ts)
4. Run:
   - `npm run build`
   - `npx tsx --test /Users/amir/Downloads/MyMake/tests/reliability-reset.test.ts`
5. If working on prod bugs, always verify fixes against Railway directly, not just local code.
6. Prefer fixing reliability holes over adding new features.

## 19. Current Operational Commands

### Local dev

```bash
cd /Users/amir/Downloads/MyMake
npm install
npm run dev
```

### Local Codex bridge

```bash
npm --prefix /Users/amir/Downloads/MyMake run codex-bridge
```

### Tests

```bash
npx tsx --test /Users/amir/Downloads/MyMake/tests/reliability-reset.test.ts
```

### Production deploy

```bash
cd /Users/amir/Downloads/MyMake
railway up -s web -c -m "your deploy message"
```

## 20. Honest Status

MyMake has real infrastructure now:

- auth
- persistence
- preview runners
- element picking
- AI routing
- revision history
- GitHub
- Codex bridge
- Figma foundation modules

But the product is still not reliably “easy and quick” enough for everyday UI editing. The right next move is not more surface area. It is tightening the chain from:

selection -> resolved target -> deterministic edit or constrained edit -> target-aware proof -> checkpoint

That is the shortest path to making the product genuinely usable.
