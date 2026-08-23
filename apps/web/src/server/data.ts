import "server-only";
import type { Trace } from "@/lib/types";
import { forWorkspace } from "@/server/clickhouse";
// type-only: erased at runtime, so naming the session's shape here never loads
// the auth stack (see `dataForSession`).
import type { SessionContext } from "@/server/session";
import { NOW } from "@/mock/generate";
import { streamLogs } from "@/mock/logstream";
import { statCards, timeseries } from "@/mock/metrics";
import { allTraces, getTrace as getMockTrace } from "@/mock/traces";
import { DEFAULT_LOG_SEVERITY, SEVERITY_ORDER } from "@/lib/logs-filter";
import {
  DEFAULT_LOG_RANGE_MS,
  capLogRows,
  queryLogSearch,
  type LogFilter,
  type LogLine,
  type LogSearchResult,
} from "@/server/queries/logs";
import {
  queryOverview,
  type Overview,
  type OverviewRange,
} from "@/server/queries/overview";
import {
  DEFAULT_TRACE_RANGE_MS,
  TRACE_PAGE_SIZE,
  queryTrace,
  queryTraceSearch,
  splitSearchTerms,
  type TraceFilter,
  type TraceSearchResult,
} from "@/server/queries/traces";

export type {
  Overview,
  OverviewPoint,
  OverviewRange,
  OverviewStat,
} from "@/server/queries/overview";
export type { TraceFilter, TraceSearchResult } from "@/server/queries/traces";
export { DEFAULT_TRACE_RANGE_MS, TRACE_PAGE_SIZE } from "@/server/queries/traces";
export type { LogFilter, LogLine, LogSearchResult } from "@/server/queries/logs";
export { DEFAULT_LOG_RANGE_MS, LOG_SEARCH_CAP } from "@/server/queries/logs";
// The logs URL vocabulary is NOT re-exported: it lives in `@/lib/logs-filter`
// (D65), which the page and the bar import directly — a facade passthrough
// would put a second import path on a client-safe module for no reason.

export type DataMode = "live" | "mock";

function resolveMode(): DataMode {
  const raw = process.env.OBSTACK_DATA_MODE ?? "mock";
  if (raw !== "live" && raw !== "mock") {
    throw new Error(`OBSTACK_DATA_MODE must be "live" or "mock", got "${raw}"`);
  }
  if (raw === "live" && !process.env.CLICKHOUSE_URL) {
    throw new Error("OBSTACK_DATA_MODE=live requires CLICKHOUSE_URL");
  }
  return raw;
}

/**
 * The one switch between the ingested pipeline and the mock product (D13).
 * Pages import this facade and nothing below it — never `@/mock/traces` and
 * never `@/server/queries/*`.
 *
 * In live mode an empty result is an empty result: surfaces render their empty
 * state and never fall back to mock data, because a silent fallback would hide
 * a broken pipeline.
 *
 * `OBSTACK_DATA_MODE` is a BUILD-time input; serve an artifact only in the mode
 * it was built — a mock-built artifact prerenders the no-form auth pages and
 * cannot sign anyone up (D157; enforcement is M4's, per S2.3 L6).
 */
export const dataMode: DataMode = resolveMode();

/**
 * The reference clock a rendered age is measured against (D50/D64): the
 * request's server time in live mode, the mock clock in mock mode — the same
 * per-mode rule the search entry points bind their time windows with, so a row
 * can never read "3h ago" inside a window the header calls "last 1h".
 *
 * It lives here because this is the module that knows the mode, and because
 * `NOW` must not leave the mock tree for a page or a component (D13/D64): the
 * traces pages sample this ONCE per request and pass the number down as a
 * prop. `searchLogs` needs no such call — its result already carries the clock
 * its own query bound.
 */
export function referenceNowMs(): number {
  return dataMode === "live" ? Date.now() : NOW;
}

// Which routes render live data is a presentation concern shared with client
// components, so the D21 registry lives in `@/lib/live-routes`, not here.

/**
 * Mock free text — the mock half of the search contract (`search-contract.md`;
 * live half: `queries/traces.ts`). Reach in view-model terms: summary fields ∪
 * span names ∪ `llm.prompt`/`llm.completion` ∪ trace-carrying log bodies —
 * nearby rows (no `traceId`) are OUT, exactly as live's `trace_id != ''` leg.
 * Terms AND; each is a case-insensitive substring over any one field. Terms
 * are whitespace-split, so no term can span the `join(" ")` field boundary.
 * Exported for the parity tests, which assert this and the live SQL return the
 * same verdicts over an equivalent fixture.
 */
export function mockMatches(trace: Trace, q: string): boolean {
  const terms = splitSearchTerms(q);
  if (terms.length === 0) return true;
  const hay = [
    trace.rootName,
    trace.id,
    ...trace.models,
    ...trace.services,
    ...trace.spans.map((s) => s.name),
    ...trace.spans.map((s) => s.llm?.prompt ?? ""),
    ...trace.spans.map((s) => s.llm?.completion ?? ""),
    ...trace.logs.filter((l) => l.traceId).map((l) => l.body),
  ]
    .join(" ")
    .toLowerCase();
  return terms.every((term) => hay.includes(term.toLowerCase()));
}

/** The PRD §8 structured filters plus the D50 time bound, mock side (search-contract.md). */
function mockMatchesFilter(trace: Trace, filter: TraceFilter, sinceMs: number): boolean {
  const status = filter.status ?? "all";
  const maxCost = filter.maxCostUsd ?? -1;
  return (
    Date.parse(trace.startedAt) >= sinceMs &&
    (status === "all" || trace.status === status) &&
    trace.durationMs >= (filter.minMs ?? 0) &&
    trace.costUsd >= (filter.minCostUsd ?? 0) &&
    (maxCost < 0 || trace.costUsd <= maxCost) &&
    (!filter.service || trace.services.includes(filter.service)) &&
    (!filter.model || trace.models.includes(filter.model)) &&
    mockMatches(trace, filter.q ?? "")
  );
}

/**
 * Mock search over an explicit trace list: filter, order, page, exact filtered
 * total — the same D44 contract shape `queryTraceSearch` answers. The list is
 * a parameter so unit tests can prove pagination and ordering over fixtures
 * larger than a page; `searchTraces` below always passes `allTraces`. Order
 * matches live's `ORDER BY min(min_start) DESC, trace_id`: start descending,
 * then trace id ascending by codepoint (ClickHouse `String` order). Reference
 * clock (D50): the mock clock `NOW`, never the wall clock — mock traces are
 * generated inside ~6h behind `NOW`, so a wall-clock reference would empty
 * every mock surface (F6/F7).
 */
export function mockSearchTraces(all: Trace[], filter: TraceFilter): TraceSearchResult {
  const sinceMs = NOW - (filter.rangeMs ?? DEFAULT_TRACE_RANGE_MS);
  const matched = all
    .filter((t) => mockMatchesFilter(t, filter, sinceMs))
    .sort(
      (a, b) =>
        Date.parse(b.startedAt) - Date.parse(a.startedAt) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  const page = Math.max(1, Math.floor(filter.page ?? 1));
  const start = (page - 1) * TRACE_PAGE_SIZE;
  return { traces: matched.slice(start, start + TRACE_PAGE_SIZE), total: matched.length };
}

/**
 * Mock free text on the LOGS surface — the mock half of the `/app/logs` search
 * rule (live half: `queries/logs.ts`). Reach is the **body only** (D51(e)): a
 * row this surface refuses to render must not be findable here either, and the
 * pod is a filter of its own rather than a search field. Terms come from the
 * one shared `splitSearchTerms`, AND across terms, case-insensitive substring —
 * the traces contract's term rules over this surface's narrower reach.
 */
export function mockLogMatches(line: LogLine, q: string): boolean {
  const body = line.body.toLowerCase();
  return splitSearchTerms(q).every((term) => body.includes(term.toLowerCase()));
}

/**
 * Mock `/app/logs` search over an explicit line list: filter, cap, pod options
 * — the same `LogSearchResult` shape `queryLogSearch` answers. The list is a
 * parameter so tests can drive fixtures the mock stream does not contain;
 * `searchLogs` below always passes `streamLogs`, which `mock/logstream.ts`
 * already sorts newest-first, so the rendered order matches live's
 * `ORDER BY timestamp DESC`. Reference clock (D50): the mock clock `NOW`, never
 * the wall clock — the mock stream lives inside ~6h behind `NOW` (F6/F7).
 *
 * The D42 content-carrier exclusion has no mock counterpart to apply: the mock
 * stream has no bodyless rows at all (data.test.ts guards that, so a mock that
 * grows carriers turns red here rather than rendering blank lines).
 */
export function mockSearchLogs(all: LogLine[], filter: LogFilter): LogSearchResult {
  const sinceMs = NOW - (filter.rangeMs ?? DEFAULT_LOG_RANGE_MS);
  const minRank = SEVERITY_ORDER.indexOf(filter.minSeverity ?? DEFAULT_LOG_SEVERITY);
  const inWindow = all.filter((line) => line.ts >= sinceMs);
  const matched = inWindow.filter(
    (line) =>
      SEVERITY_ORDER.indexOf(line.severity) >= minRank &&
      (!filter.pod || line.pod === filter.pod) &&
      (!filter.onTraceOnly || Boolean(line.traceId)) &&
      mockLogMatches(line, filter.q ?? ""),
  );
  return {
    ...capLogRows(matched),
    // Same rule as live: the window and the carrier state decide the options,
    // never the other filters.
    pods: [...new Set(inWindow.filter((line) => line.pod).map((line) => line.pod))].sort(),
    nowMs: NOW,
  };
}

// ---- the workspace's reads (D96/D113) ---------------------------------------

/**
 * Every read the product makes, bound to ONE workspace. There is no unscoped
 * variant: a caller holds this object or it has no reads at all, so a surface
 * cannot forget to say which workspace it is asking about (D96 — an omitted
 * tenancy predicate is a cross-tenant leak, not a wrong answer).
 */
export interface WorkspaceData {
  /** the workspace the live reads bind; null in mock mode, which has no tenant */
  workspaceId: string | null;
  getTrace(id: string): Promise<Trace | undefined>;
  /** the traces-list read (D44): one page plus the exact filtered total */
  searchTraces(filter?: TraceFilter): Promise<TraceSearchResult>;
  getOverview(range?: OverviewRange): Promise<Overview>;
  /** the `/app/logs` read: one capped window plus its pod options (D44/D48) */
  searchLogs(filter?: LogFilter): Promise<LogSearchResult>;
}

/**
 * Mock mode's reads: the mock modules, no workspace, no store. It is a single
 * value rather than a per-call object because mock mode has nothing to scope —
 * the demo product is one dataset, and pretending it has a tenant would be its
 * own small fiction (D13).
 */
const MOCK_DATA: WorkspaceData = {
  workspaceId: null,
  async getTrace(id) {
    return getMockTrace(id);
  },
  async searchTraces(filter = {}) {
    return mockSearchTraces(allTraces, filter);
  },
  async getOverview() {
    return { points: timeseries(), stats: [...statCards] };
  },
  async searchLogs(filter = {}) {
    return mockSearchLogs(streamLogs, filter);
  },
};

/**
 * The explicit entry (D113): the caller names the workspace, because it is a
 * caller that already knows it — a harness or a test that seeded the rows, or
 * the bench with its own fixture workspace. NO fallback and no env read: the
 * argument is the only source, and `forWorkspace` refuses an empty one.
 *
 * Mock mode short-circuits here, before the ClickHouse scope is built, so the
 * demo product still runs with no ClickHouse present at all.
 */
export function dataForWorkspace(workspaceId: string): WorkspaceData {
  if (dataMode === "mock") return MOCK_DATA;
  const ch = forWorkspace(workspaceId);
  return {
    workspaceId,
    getTrace: (id) => queryTrace(ch, id),
    searchTraces: (filter = {}) => queryTraceSearch(ch, filter),
    getOverview: (range = "6h") => queryOverview(ch, range),
    searchLogs: (filter = {}) => queryLogSearch(ch, filter),
  };
}

/**
 * D96/D113's refusal: a live-mode read with no session has no workspace to
 * scope to, and there is no default to fall back on. Every production caller
 * of `dataForSessionContext` below already turns a null session into its own
 * response before reaching it — a 401 (`onboarding/status/route.ts`,
 * `traces/[id]/explain/route.ts`) or a `redirect` (`onboarding/page.tsx`) —
 * and `dataForSession` no longer reaches it with a null at all (D274, next).
 * So this constructor runs in production only if one of those guards is ever
 * dropped, which is exactly the bug class D96 exists to catch loudly. Tests
 * drive it directly (`tenancy.test.ts:210`).
 */
export class NoSessionError extends Error {
  constructor() {
    super("no signed-in session: a live-mode read has no workspace to scope to");
    this.name = "NoSessionError";
  }
}

/**
 * The half of `dataForSession` a test can drive without a request (the
 * `resolveSessionContext` pattern). A missing session is a refusal, never a
 * default workspace — the whole point of D96 is that there is no workspace to
 * fall back to. This stays a throw rather than a redirect: it has no request
 * shape of its own (a route handler, a page, a test) to decide a response
 * for, so that decision belongs to the caller, not here.
 */
export function dataForSessionContext(session: SessionContext | null): WorkspaceData {
  if (!session) throw new NoSessionError();
  return dataForWorkspace(session.workspaceId);
}

/**
 * The product entry (D113): the signed-in session's active workspace, resolved
 * once and handed to the single `forWorkspace` call `dataForWorkspace` makes.
 *
 * Mock mode short-circuits on the mode check before anything session-shaped is
 * touched — including the IMPORT below, which is dynamic for exactly that
 * reason (D114 byte-invariance: the demo product must run with no Postgres
 * present at all, and importing this facade must not drag the auth stack in
 * behind it).
 *
 * No session (D274, replacing D269): every wired `/app` page calls this and
 * races `app/app/layout.tsx`'s own session read (D114); the layout's
 * `redirect()` is what wins that race and what the client actually receives,
 * a 307. A losing call used to reach `dataForSessionContext` and throw
 * `NoSessionError`, which Next logged at error level for an outcome the
 * client never saw as anything but that redirect. `redirect("/login")` here
 * instead: the same NEXT_REDIRECT short-circuit terminates this render before
 * anything logs, and the client's 307 is byte-identical to before.
 * `next/navigation` is imported dynamically, inside the branch that actually
 * redirects, for the same reason `getSessionContext` above is: this module is
 * loaded by every test that imports the facade (`layout.test.ts`'s D114
 * graph-load test, `tenancy.test.ts`, `data.test.ts`), and a component-side
 * Next module at module scope is exactly what those tests run under
 * `--conditions react-server` to prove this graph can do without.
 */
export async function dataForSession(): Promise<WorkspaceData> {
  if (dataMode === "mock") return MOCK_DATA;
  const { getSessionContext } = await import("@/server/session");
  const session = await getSessionContext();
  if (!session) {
    const { redirect } = await import("next/navigation");
    redirect("/login");
  }
  return dataForSessionContext(session);
}
