# Design: Four new product surfaces (Dashboards, Explorer, On-call, Service Catalog)

**Date:** 2026-08-10
**Status:** Approved by Ziad
**Goal:** Fill product-surface gaps so obstack reads as a complete Datadog/Grafana-class product. All data stays mock; interactions are working client-side state (no persistence — resets on reload is acceptable).

## Decisions already made

- **Scope:** four new surfaces — Dashboards builder, Metrics explorer, On-call + notifications, Service catalog.
- **Depth:** working interactions (real add/remove/reorder/toggle state), not static mockups and not localStorage-persisted.
- **Integration:** shared client store (Option B) — the explorer "Save to dashboard" flow genuinely adds a widget that appears on the dashboard.
- **Determinism:** all generated series must use the existing seeded-PRNG pattern (`mulberry32` from `src/mock/rand.ts` + the fixed `NOW` anchor in `src/mock/generate.ts`) so SSR and client render identically. Never use `Math.random()`/`Date.now()` in mock data.

## Architecture

### Shared store — `src/state/workspace-store.tsx` (new)

Client component exporting `WorkspaceProvider` + `useWorkspace()` hook (plain React context + `useState`; no external state lib). Mounted inside `src/app/app/layout.tsx` wrapping children (layout stays a server component; the provider is `"use client"`).

State and actions:

- `dashboards: Dashboard[]` — seeded from `src/mock/dashboards.ts`
  - `createDashboard(name: string): id`
  - `addWidget(dashboardId, widget)`
  - `removeWidget(dashboardId, widgetId)`
  - `moveWidget(dashboardId, widgetId, direction: "up" | "down")`
- `channels: NotificationChannel[]` — seeded from `src/mock/oncall.ts`
  - `toggleChannel(channelId)`

Only editable data lives in the store. Everything read-only stays as plain mock module imports, like the rest of the app.

## Surfaces

### 1. Dashboards — `/app/dashboards` and `/app/dashboards/[id]`

- **New files:** `src/app/app/dashboards/page.tsx`, `src/app/app/dashboards/[id]/page.tsx`, `src/mock/dashboards.ts`, components under `src/components/dashboards/`.
- **List page:** cards for 4 seeded dashboards — "AI Overview", "Checkout Golden Signals", "Infra Capacity", "LLM Cost & Tokens" — showing widget count, owner team, last-updated. "New dashboard" button creates an empty dashboard in the store and navigates to it.
- **Detail page:** responsive widget grid rendered from store state. Widget types: `timeseries` (line/area), `stat` (big number + delta), `topn` (horizontal bar), `table`. Each widget binds to an entry in a widget catalog in `mock/dashboards.ts` that maps to a deterministic generated series.
- **Edit mode:** toggle button. In edit mode each widget gets remove + move up/down controls; an "Add widget" tile opens a picker modal listing the widget catalog. No drag-and-drop (deliberately excluded — heavy for little demo payoff).
- Since `[id]` includes user-created dashboards, the detail page reads from the store (client component); unknown ids show a friendly "dashboard not found" state.

### 2. Metrics explorer — `/app/explore`

- **New files:** `src/app/app/explore/page.tsx`, components under `src/components/explore/`, metric catalog in `src/mock/explore.ts` (the dashboards widget picker imports from it too, so widget types and explorer metrics stay one catalog).
- **Catalog:** ~15 metrics spanning the five layers (api: request rate, p95 latency, error rate; agent: run duration, step count; tool: call latency, failure rate; llm: tokens/min, cost/hr, TTFT; infra: CPU, memory, pod restarts).
- **Controls:** metric picker (left rail), filter chips (service, env), group-by (none/service/model/route), time range (1h/6h/24h), chart type (line/area/bar).
- **Rendering:** series is generated deterministically with a seed derived from the query shape (metric + filters + group-by), so every control change instantly produces a stable, plausible chart.
- **Save to dashboard:** button opens dashboard picker (from store) → `addWidget` → toast with link to the target dashboard. This is the flagship cross-surface flow; it must genuinely work.

### 3. On-call & notifications — `/app/oncall`

- **New files:** `src/app/app/oncall/page.tsx`, `src/mock/oncall.ts`, components under `src/components/oncall/`.
- **Sections (top to bottom):**
  1. **Now on call** — per team (Platform, AI, Infra): primary + secondary, until-time.
  2. **Rotation schedule** — 7-day strip per team showing who holds primary each day.
  3. **Escalation policies** — e.g. "page primary → 5 min no-ack → secondary → 15 min → #incidents Slack".
  4. **Notification channels** — Slack `#incidents`, PagerDuty, email digest, webhook — with working enable toggles (store-backed).
  5. **Routing table** — maps existing `alertRules` (import from `src/mock/intelligence.ts`) → escalation policy → channels, so the page is visibly wired to `/app/alerts`.
- Team names must match the owner teams used in the service catalog (one consistent world).

### 4. Service catalog — `/app/services` and `/app/services/[id]`

- **New files:** `src/app/app/services/page.tsx`, `src/app/app/services/[id]/page.tsx`, `src/mock/catalog.ts`, components under `src/components/services/`.
- **Directory table:** service name, layer chip (existing `LayerChip`), owner team, tier (1–3), runtime (node/python/go), dependency count, SLO status, scorecard grade A–F.
- **Detail page:** scorecard breakdown (observability coverage, alerts configured, runbook linked, SLO defined — each pass/fail with points), dependency list (links to `/app/map`), recent deploys (reuse `deploys` from `mock/intelligence.ts`), open incidents (link to `/app/incidents`).
- Services should be the same services that already appear across traces/map/infra mocks (gateway, agent-worker, tools, sync-worker, etc.) — no new invented systems.

## Wiring

- **SideNav** (`src/components/shell/SideNav.tsx`): add Dashboards (after Overview), Explore (after Traces), On-call (after Alerts), Services (after Map). Pick lucide icons consistent with existing set (e.g. `LayoutGrid`, `Telescope`/`SearchCode`, `PhoneCall`, `Boxes`).
- **CommandPalette:** add all four routes, matching how `/app/docs` was added.
- Existing pages are not modified beyond nav/palette.

## Error handling

Mock-data app: the only real failure surfaces are unknown dynamic ids (`/app/dashboards/[id]`, `/app/services/[id]`) → render a styled not-found state with a link back to the list.

## Testing / verification

1. `npm run build` (or `next build`) passes clean; new routes compile.
2. Playwright: screenshot each of the 6 new pages (4 lists/pages + 2 detail pages).
3. Exercise the three key interactions end-to-end in the browser: (a) add + remove + reorder a dashboard widget, (b) explorer → save to dashboard → widget visible on that dashboard, (c) toggle a notification channel.
4. Verify no hydration warnings in console (determinism check).

## Out of scope

Drag-and-drop widget layout, localStorage persistence, real data ingestion, auth, editing on-call schedules, creating alert rules, synthetics/RUM/profiling/audit-log surfaces (possible later batches).
