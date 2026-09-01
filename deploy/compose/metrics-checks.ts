/**
 * The metrics query-contract checks the `e2e` drive asserts with (S6.1 T8,
 * D370) — `trace-checks.ts`'s pattern applied to T6's frozen contract
 * (`@/lib/metrics-types`, answered by `@/server/queries/metrics`).
 *
 * This file is BOTH the checks and the small CLI that carries them across a
 * language boundary, which is why the two are not split the way `smoke.ts` and
 * `trace-checks.ts` are: `e2e-drive.mjs` is plain node and cannot import a
 * `@/` TypeScript module at all, so it spawns this under tsx with the very
 * environment the app is served with, reads the claims off stdout as JSON, and
 * re-states every one of them in its own transcript.
 *
 * It reports CLAIMS rather than throwing a `problems[]` error the way
 * `trace-checks.ts` does, and that difference is the process boundary: a throw
 * crosses it as an exit code and a stack, so the drive's transcript would read
 * "the checks failed" instead of which metric answered what. A deadline here
 * is therefore a claim that came back false, carrying the catalog it last read
 * as its detail — the same information, in the shape the reader needs.
 *
 * Like the modules it drives, it resolves nothing at import time (D13): the
 * caller sets OBSTACK_DATA_MODE / CLICKHOUSE_* BEFORE the first check runs,
 * which is when `@/server/queries/metrics` is first imported.
 *
 * The workspace is the caller's first argument, never an env read and never a
 * default (D96/D113) — exactly for the caller that seeded the rows it is about
 * to assert on.
 *
 *   npx tsx --tsconfig apps/web/tsconfig.json --conditions react-server \
 *     deploy/compose/metrics-checks.ts <workspace_id> <expectations_json> [--absent]
 */
import type {
  MetricAgg,
  MetricCatalogEntry,
  MetricRange,
  MetricSeriesPoint,
  MetricSeriesResult,
} from "@/lib/metrics-types";

/** The width every claim below is made at: 60 one-minute buckets (`RANGES` in
 *  `server/queries/metrics.ts`), the narrowest and the only one whose grid a
 *  minute-stamped fixture lands in exactly. */
export const RANGE: MetricRange = "1h";
export const RANGE_POINTS = 60;

/** Ingest batches at 1s and the MVs fire on insert, but the drive spawns this
 *  the instant the export's 200 came back — so the catalog is polled, not
 *  sampled once. Deliberately longer than `trace-checks.ts`'s 30s: this walks
 *  the write path AND three materialized views on a cold compose stack. */
export const ARRIVAL_TIMEOUT_MS = 60_000;
const POLL_MS = 1_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One metric the seeder says it sent, exactly as `exit-seed.mjs --leg metrics`
 * printed it. The seeder is the ONE definition of the fixture (D115), so every
 * number here is read from what wrote it — nothing in this file restates a
 * value the export chose.
 */
export interface MetricExpectation {
  name: string;
  type: "gauge" | "sum" | "histogram";
  unit: string;
  /** The contract's ISO UTC minute, as the catalog renders it. */
  lastSeen: string;
  /** Keys the catalog must list — a subset claim: the merged label set may
   *  legitimately carry more (D375), never fewer. */
  attrKeys: string[];
  agg: MetricAgg;
  value: number;
  /** `MetricSeriesPoint.t` of the one bucket the export landed in. */
  bucket: string;
  groupBy: string;
  group: string;
}

/**
 * One assertion, in the shape the drive re-states it. `metric` is what ties a
 * claim back to the expectation it came from: a run that quietly answered for
 * two of three metrics is otherwise indistinguishable from a green one, and
 * the drive checks the tie rather than a count it would have to restate.
 */
export interface MetricClaim {
  metric: string;
  claim: string;
  ok: boolean;
  detail: string;
}

/** (name, type) is the catalog's identity since D378/D384 — never the name. */
const key = (m: { name: string; type: string }): string => `${m.name}:${m.type}`;

/** What the catalog says about one expected metric, as a claim either way. */
function catalogClaim(e: MetricExpectation, catalog: MetricCatalogEntry[]): MetricClaim {
  const entry = catalog.find((c) => c.name === e.name && c.type === e.type);
  const missing = entry ? e.attrKeys.filter((k) => !entry.attrKeys.includes(k)) : e.attrKeys;
  return {
    metric: key(e),
    claim:
      `the catalog DISCOVERED ${e.name} as a ${e.type} — unit "${e.unit}", last seen ${e.lastSeen}, ` +
      `attributes ${e.attrKeys.join(" + ")}`,
    ok:
      entry !== undefined &&
      entry.unit === e.unit &&
      entry.lastSeen === e.lastSeen &&
      missing.length === 0,
    detail: entry
      ? `unit="${entry.unit}" lastSeen=${entry.lastSeen} attrKeys=[${entry.attrKeys.join(", ")}]` +
        (missing.length > 0 ? ` missing=[${missing.join(", ")}]` : "")
      : `not listed — the catalog holds [${catalog.map(key).join(", ") || "nothing"}]`,
  };
}

/**
 * Everything the catalog does not yet say about what the seeder sent, or an
 * empty list. This is the ARRIVAL predicate `awaitMetricSeries` polls on, and
 * the reason the series are never queried before it holds: an unknown (name,
 * type) is answered honestly empty by contract (D384), so a series read that
 * raced the write would assert against that contract instead of the fixture.
 */
export function problemsWithMetrics(
  expectations: MetricExpectation[],
  catalog: MetricCatalogEntry[],
): string[] {
  return expectations
    .map((e) => catalogClaim(e, catalog))
    .filter((c) => !c.ok)
    .map((c) => `${c.metric}: ${c.detail}`);
}

/** "HH:MM" as minutes since UTC midnight — the grid claim's only arithmetic. */
const minuteOf = (t: string): number => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/** How the grid is wrong, or undefined. Modulo a day, because a 60-bucket 1h
 *  window legitimately spans midnight. */
function gridProblem(points: MetricSeriesPoint[]): string | undefined {
  if (points.length !== RANGE_POINTS) return `${points.length} points, want ${RANGE_POINTS}`;
  for (let i = 1; i < points.length; i++) {
    if ((minuteOf(points[i].t) - minuteOf(points[i - 1].t) + 1440) % 1440 !== 1) {
      return `${points[i - 1].t} → ${points[i].t} is not one minute`;
    }
  }
  return undefined;
}

/** What the two series queries answered about one metric, as claims. */
function seriesClaims(
  e: MetricExpectation,
  ungrouped: MetricSeriesResult,
  grouped: MetricSeriesResult,
): MetricClaim[] {
  const series = ungrouped.series[0];
  const points = series?.points ?? [];
  const grid = gridProblem(points);
  const filled = points.filter((p) => p.v !== null);
  const at = points.find((p) => p.t === e.bucket);
  const groups = grouped.series.map((s) => s.group);
  return [
    {
      metric: key(e),
      claim: `${e.name} answers on ONE ungrouped series over ${RANGE_POINTS} one-minute buckets, totalGroups 1 (D381)`,
      ok:
        ungrouped.series.length === 1 &&
        series?.group === null &&
        grid === undefined &&
        ungrouped.totalGroups === 1,
      detail:
        `${ungrouped.series.length} series · group=${String(series?.group)} · ` +
        `totalGroups=${ungrouped.totalGroups} · grid=${grid ?? `${points.length} × 1m`}`,
    },
    {
      metric: key(e),
      claim:
        `"${e.agg}" over it is ${e.value} in the ${e.bucket} bucket the export landed in, and every other ` +
        `bucket is null — an honest gap, never 0`,
      ok: at?.v === e.value && filled.length === 1,
      detail:
        `${e.bucket}=${at === undefined ? "no such bucket" : String(at.v)} · ` +
        `${filled.length} non-null bucket(s) [${filled.map((p) => `${p.t}=${String(p.v)}`).join(", ")}]`,
    },
    {
      metric: key(e),
      claim: `grouped by ${e.groupBy} it is the ONE group "${e.group}" the export's resource named`,
      ok: groups.length === 1 && groups[0] === e.group && grouped.totalGroups === 1,
      detail: `groups=[${groups.join(", ")}] · totalGroups=${grouped.totalGroups}`,
    },
  ];
}

/**
 * Poll the catalog until it lists everything the seeder sent, then ask the
 * contract for each series both ungrouped and grouped, and return every claim.
 *
 * A passed deadline is not an exception here: the catalog claims are built
 * from the LAST read either way, so what comes back on red says exactly which
 * (name, type) never appeared and what the catalog held instead. The series
 * queries are skipped in that case — they would only restate the same absence.
 */
export async function awaitMetricSeries(
  workspaceId: string,
  expectations: MetricExpectation[],
  timeoutMs: number = ARRIVAL_TIMEOUT_MS,
): Promise<MetricClaim[]> {
  const { listMetricCatalog, queryMetricSeries } = await import("@/server/queries/metrics");
  const { forWorkspace } = await import("@/server/clickhouse");
  const ch = forWorkspace(workspaceId);

  const deadline = Date.now() + timeoutMs;
  let catalog = await listMetricCatalog(ch);
  while (problemsWithMetrics(expectations, catalog).length > 0 && Date.now() < deadline) {
    await sleep(POLL_MS);
    catalog = await listMetricCatalog(ch);
  }

  const claims = expectations.map((e) => catalogClaim(e, catalog));
  if (claims.some((c) => !c.ok)) return claims;

  for (const e of expectations) {
    const [ungrouped, grouped] = await Promise.all([
      queryMetricSeries(ch, {
        metric: e.name,
        type: e.type,
        range: RANGE,
        agg: e.agg,
        groupBy: null,
        filters: {},
      }),
      queryMetricSeries(ch, {
        metric: e.name,
        type: e.type,
        range: RANGE,
        agg: e.agg,
        groupBy: e.groupBy,
        filters: {},
      }),
    ]);
    claims.push(...seriesClaims(e, ungrouped, grouped));
  }
  return claims;
}

/**
 * The tenancy half (D142): discovery is per workspace, so the OTHER stranger's
 * catalog lists none of these. Read once and never polled — an absence cannot
 * be waited for, and by the time the drive asks this the rows have already
 * been proven present in the workspace that sent them.
 */
export async function metricsAbsentFrom(
  workspaceId: string,
  expectations: MetricExpectation[],
): Promise<MetricClaim> {
  const { listMetricCatalog } = await import("@/server/queries/metrics");
  const { forWorkspace } = await import("@/server/clickhouse");
  const catalog = await listMetricCatalog(forWorkspace(workspaceId));
  const leaked = catalog.filter((c) => expectations.some((e) => e.name === c.name && e.type === c.type));
  return {
    metric: "tenancy",
    claim: `${workspaceId}'s catalog lists NONE of the metrics the other workspace sent — discovery is per tenant (D142)`,
    ok: leaked.length === 0,
    detail: `catalog holds [${catalog.map(key).join(", ") || "nothing"}]`,
  };
}

function fail(message: string): never {
  console.error(`metrics-checks: ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const [workspaceId, expectationsJson, ...flags] = process.argv.slice(2);
  if (!workspaceId || !expectationsJson) {
    fail("usage: metrics-checks.ts <workspace_id> <expectations_json> [--absent]");
  }
  const expectations = JSON.parse(expectationsJson) as MetricExpectation[];

  // The ClickHouse client resolves its connection at import time (D13), so the
  // env comes first. The caller's wins: the drive exports the same values it
  // serves the app with, and these defaults only carry a standalone run.
  process.env.OBSTACK_DATA_MODE = "live";
  process.env.CLICKHOUSE_URL ??= "http://127.0.0.1:8123";
  process.env.CLICKHOUSE_USER ??= "obstack_web";
  process.env.CLICKHOUSE_PASSWORD ??= "obstack_web_dev";

  const claims = flags.includes("--absent")
    ? [await metricsAbsentFrom(workspaceId, expectations)]
    : await awaitMetricSeries(workspaceId, expectations);

  console.log(JSON.stringify({ workspace: workspaceId, claims }, null, 2));
  // Stdout is the drive's channel and the exit code is a second, independent
  // gate on the same claims — a reader with only one of them is still told.
  process.exit(claims.every((c) => c.ok) ? 0 : 1);
}

main().catch((err: unknown) => fail(err instanceof Error ? (err.stack ?? err.message) : String(err)));
