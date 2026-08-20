import assert from "node:assert/strict";
import test from "node:test";
import type { QueryResultRow } from "pg";
import type { TraceSearchResult } from "@/server/queries/traces";
import { INGEST_ENDPOINT, getOnboardingStatus } from "./onboarding";
import type { QueryRows } from "./postgres";

// run with: npm test --workspace apps/web
//
// The onboarding read, with no Postgres and no ClickHouse: arrival is the D100
// counters and nothing else (D203), the trace link is a resolver that runs only
// after they say yes, and the two halves are one status (D209). Both seams are
// injected (D113/D181), so every branch here is drivable — including the one a
// real stack can only show for a couple of seconds (arrived, not yet queryable).

// The mode the route branch below asserts on, made a fact of this process
// rather than of whoever's shell ran the suite (D156: `node --test` isolates
// per file, so this mutation dies with it).
delete process.env.OBSTACK_DATA_MODE;

type Statement = { sql: string; params?: unknown[] };

function recordingQuery(rows: unknown[] = []) {
  const seen: Statement[] = [];
  const query: QueryRows = async <Row extends QueryResultRow>(
    sql: string,
    params: unknown[] = [],
  ): Promise<Row[]> => {
    seen.push({ sql, params });
    return rows as Row[];
  };
  return { query, seen };
}

/** A health row as Postgres RETURNs it: bigints as strings, timestamps as Dates. */
const healthRow = (over: Record<string, unknown> = {}) => ({
  key_id: "key_0011223344556677",
  name: "Quickstart",
  prefix: "ok_live_9f3a",
  revoked_at: null,
  accepted: "12",
  dropped_decode: "0",
  dropped_unsupported: "0",
  dropped_quota: "0",
  last_event_at: new Date("2026-08-20T10:00:00Z"),
  updated_at: new Date("2026-08-20T10:00:05Z"),
  ...over,
});

/** The facade half: what `searchTraces` answered, and whether it was asked. */
function stubData(result: TraceSearchResult = { traces: [], total: 0 }) {
  const calls: unknown[] = [];
  return {
    data: {
      searchTraces: async (filter: unknown = {}) => {
        calls.push(filter);
        return result;
      },
    },
    calls,
  };
}

const summary = (id: string) => ({ id }) as TraceSearchResult["traces"][number];

test("no event timestamp anywhere is not-arrived, and costs no trace query", async () => {
  const { query, seen } = recordingQuery([
    healthRow({ accepted: "0", last_event_at: null, updated_at: null }),
  ]);
  const { data, calls } = stubData();

  const status = await getOnboardingStatus("ws_a", data, query);

  assert.deepEqual(status, { arrived: false, firstTrace: null, asOf: null });
  // The resolver is a LINK resolver, not a second arrival signal (D203): asking
  // ClickHouse every five seconds for a workspace that has sent nothing would be
  // a second path to the same question, and a poll's worth of load per visitor.
  assert.equal(calls.length, 0, "the trace search ran before the counters said yes");
  // And the counters were read where the product reads them, bound to the one
  // workspace (D11/D148).
  assert.equal(seen.length, 1);
  assert.match(seen[0].sql, /api_key_health/);
  assert.deepEqual(seen[0].params, ["ws_a"]);
});

test("arrival is any key's lastEventAt, and the link is the workspace's own trace", async () => {
  const { query } = recordingQuery([
    // One silent key beside one that has received: the predicate is "any", so a
    // second unused key must not hold the panel at waiting forever.
    healthRow({ key_id: "key_silent", last_event_at: null, updated_at: null }),
    healthRow(),
  ]);
  const { data, calls } = stubData({ traces: [summary("trace_first"), summary("trace_2")], total: 2 });

  const status = await getOnboardingStatus("ws_a", data, query);

  assert.deepEqual(status, {
    arrived: true,
    firstTrace: { id: "trace_first" },
    // The staleness the panel shows is the same read's, formatted UTC on the
    // server so a date is never formatted in two timezones across hydration.
    asOf: "2026-08-20 10:00 UTC",
  });
  assert.equal(calls.length, 1, "one search, through the scoped facade");
});

test("arrived but not yet queryable keeps the panel waiting on the LINK (D203)", async () => {
  // The real window between the 5s counter flush and the row being searchable.
  // The status does NOT lie about its own counters — `arrived` stays true — and
  // the panel waits because there is no trace to link yet.
  const { query } = recordingQuery([healthRow()]);
  const { data } = stubData({ traces: [], total: 0 });

  const status = await getOnboardingStatus("ws_a", data, query);

  assert.equal(status.arrived, true);
  assert.equal(status.firstTrace, null);
  assert.equal(status.asOf, "2026-08-20 10:00 UTC");
});

test("the endpoint the quickstart tells an operator to export to is this environment's", async () => {
  // Nothing here is hosted (U1), so a hosted name would be the S2.2 L1 lie the
  // old snippets carried. Unset in this process, so this asserts the default:
  // compose's published OTLP/HTTP port, the one the e2e drive itself sends to.
  assert.equal(process.env.OBSTACK_INGEST_ENDPOINT, undefined);
  assert.equal(INGEST_ENDPOINT, "http://127.0.0.1:4318");
  assert.equal(INGEST_ENDPOINT.includes("obstack.dev"), false);
});

test("the status poll is a 404 with a tripwire in mock mode (D203/D193)", async () => {
  // This process has no OBSTACK_DATA_MODE, so the route module resolves mock —
  // the deployment that ingests nothing and whose panel never polls. A request
  // that arrives here came from somewhere no visitor can be, so the route does
  // not exist for it and the log is at error level (D193).
  //
  // The unauthenticated 401 below that branch is proven by the drive's
  // unauthenticated probe (T6): it needs a live mode with a real auth stack,
  // which is exactly what this process is built to lack.
  const { GET } = await import("@/app/app/onboarding/status/route");

  const logged: string[] = [];
  const real = console.error;
  console.error = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
  let response: Response;
  try {
    response = await GET();
  } finally {
    console.error = real;
  }

  assert.equal(response.status, 404);
  assert.equal(await response.text(), "");
  assert.match(logged[0] ?? "", /\[onboarding\] status polled in mock mode/);
});
