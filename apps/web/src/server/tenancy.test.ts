import assert from "node:assert/strict";
import test from "node:test";
import * as clickhouse from "./clickhouse";
import type { ScopedClickHouse } from "./clickhouse";
import { forWorkspace } from "./clickhouse";
import { dataForSession, dataForSessionContext, dataForWorkspace, NoSessionError } from "./data";
import { queryLogSearch } from "./queries/logs";
import { queryOverview } from "./queries/overview";
import { queryTrace, queryTraceSearch } from "./queries/traces";

// run with: npm test --workspace apps/web
//
// The tenancy refit's hermetic half (D96/D113): the scoped factory's refusals,
// the shape of what the read layer sends, and the facade's two entry points.
// Nothing here needs a server — the tripwire fires before a client is ever
// built, which is the point of it. Its live half is
// `queries/traces.integration.test.ts`'s two-workspace disjointness probe,
// which proves the value actually bound is the scope's.
//
// This process must have NO ClickHouse to reach: the "a scoped statement gets
// PAST the tripwire" control below is proven by which error it fails with, and
// CI hands `npm test` a live CLICKHOUSE_URL (.github/workflows/web.yml). Same
// for Postgres: mock mode must resolve a facade with no DSN present at all
// (D114), so this file removes both rather than assuming them absent.
delete process.env.CLICKHOUSE_URL;
delete process.env.OBSTACK_POSTGRES_DSN;

// ---- the factory is the only door (D113) ------------------------------------

test("clickhouse.ts exports the scoped factory and nothing else", () => {
  // The raw client and the unscoped `queryRows` are module-private: an export
  // of either is a way to run SQL with no workspace at all, which is the thing
  // D96 deleted. `ScopedClickHouse` is a type and erases at runtime.
  assert.deepEqual(Object.keys(clickhouse), ["forWorkspace"]);
});

test("forWorkspace refuses an empty, blank or missing workspace id — there is no default", () => {
  // `workspace_id = ''` is a legal predicate that reads every row that arrived
  // without a workspace, so an empty id must die here rather than at the server.
  assert.throws(() => forWorkspace(""), /forWorkspace requires a workspace id/);
  assert.throws(() => forWorkspace("   "), /forWorkspace requires a workspace id/);
  assert.throws(
    () => forWorkspace(undefined as unknown as string),
    /forWorkspace requires a workspace id/,
  );
  assert.throws(() => forWorkspace(null as unknown as string), /forWorkspace requires a workspace id/);
});

// ---- the tripwire, D113's two clauses ---------------------------------------

const SCOPED_SQL = "SELECT count() FROM obstack.spans WHERE workspace_id = {workspace_id:String}";

test("clause (i): SQL with no workspace placeholder is refused before any query runs", async () => {
  const ch = forWorkspace("ws_a");
  // The red run: delete the placeholder check in `runScoped` and this statement
  // is executed instead — it fails on the missing CLICKHOUSE_URL, i.e. with the
  // wrong error, which is what makes the assertion falsifiable rather than
  // merely satisfied.
  await assert.rejects(
    ch.queryRows("SELECT count() FROM obstack.spans"),
    /refusing unscoped SQL/,
  );
  // Same shape as the real leak this guards: a predicate that was dropped from
  // an otherwise correct statement.
  await assert.rejects(
    ch.queryRows("SELECT count() FROM obstack.spans WHERE trace_id = {trace_id:String}", {
      trace_id: "t1",
    }),
    /refusing unscoped SQL/,
  );
});

test("clause (i) control: a scoped statement passes the tripwire and reaches the client", async () => {
  const ch = forWorkspace("ws_a");
  // No CLICKHOUSE_URL in this process (see the header), so "got as far as the
  // client" is provable by the error it fails with. Without this control the
  // clause above would also pass a tripwire that refused everything.
  await assert.rejects(ch.queryRows(SCOPED_SQL), /CLICKHOUSE_URL is required/);
});

test("clause (ii): a caller-supplied workspace_id that is not the scope's is refused", async () => {
  const ch = forWorkspace("ws_a");
  // The cross-tenant call this refuses is not hypothetical: it is what a query
  // function looks like when it keeps binding a workspace of its own after the
  // scope started binding one.
  await assert.rejects(
    ch.queryRows(SCOPED_SQL, { workspace_id: "ws_b" }),
    /refusing a caller-supplied workspace_id \("ws_b"\) that is not this scope's \("ws_a"\)/,
  );
  // Equal is not conflicting — it is the same binding, and the scope's value
  // wins either way.
  await assert.rejects(
    ch.queryRows(SCOPED_SQL, { workspace_id: "ws_a" }),
    /CLICKHOUSE_URL is required/,
  );
});

// ---- what the read layer sends (D113: no query names a workspace) -----------

type Call = { sql: string; params: Record<string, unknown> };

/** One merged summary row, enough for `toTrace` to answer without a server. */
const SUMMARY_ROW = {
  trace_id: "t1",
  min_start_ns: "0",
  started_ms: "0",
  duration_ns: "0",
  span_count: "0",
  error_count: "0",
  input_tokens: "0",
  output_tokens: "0",
  cost_usd: 0,
  services: [],
  models: [],
  root_name: "POST /probe",
  root_method: "POST",
  root_service: "svc",
};

const STATS_ROW = {
  requests: "0",
  error_traces: "0",
  p95: 0,
  cost_usd: 0,
  prev_requests: "0",
  prev_error_traces: "0",
  prev_p95: 0,
  prev_cost_usd: 0,
};

function cannedRows(sql: string): unknown[] {
  if (sql.includes("AND trace_id = {trace_id:String}") && sql.includes("GROUP BY workspace_id, trace_id")) {
    return [SUMMARY_ROW];
  }
  if (sql.includes("prev_requests")) return [STATS_ROW];
  return [];
}

/** A `ScopedClickHouse` that records instead of executing: the read layer's own outgoing statements. */
function recorder(): { ch: ScopedClickHouse; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    ch: {
      async queryRows<Row>(sql: string, params: Record<string, unknown> = {}): Promise<Row[]> {
        calls.push({ sql, params });
        return cannedRows(sql) as Row[];
      },
    },
  };
}

test("every read the query layer issues is scoped, and none of them names a workspace", async () => {
  const cases: [string, number, (ch: ScopedClickHouse) => Promise<unknown>][] = [
    // trace detail reads four statements: summary, spans, solid logs, nearby logs
    ["queryTrace", 4, (ch) => queryTrace(ch, "t1")],
    ["queryTraceSearch", 2, (ch) => queryTraceSearch(ch, { q: "needle" })],
    ["queryLogSearch", 2, (ch) => queryLogSearch(ch, { q: "needle" })],
    ["queryOverview", 2, (ch) => queryOverview(ch, "6h")],
  ];

  for (const [label, expectedCalls, run] of cases) {
    const { ch, calls } = recorder();
    await run(ch);
    // A function that issued nothing would satisfy the two invariants below
    // vacuously — the count is what keeps this guard honest.
    assert.equal(calls.length, expectedCalls, `${label} issued ${calls.length} statements`);
    for (const call of calls) {
      assert.ok(
        call.sql.includes("{workspace_id:"),
        `${label} sent a statement with no workspace placeholder: ${call.sql.trim().split("\n")[0]}`,
      );
      assert.ok(
        !("workspace_id" in call.params),
        `${label} bound a workspace_id of its own — the scope is the only thing allowed to (D113)`,
      );
    }
  }
});

// ---- the facade's two entry points (D113) -----------------------------------

test("dataForWorkspace short-circuits to the mock reads before any store is touched", async () => {
  // No CLICKHOUSE_URL in this process: in live mode building the scope would
  // still succeed (the client is lazy), but the reads below would not — mock
  // mode never gets that far, which is what "the demo runs with no ClickHouse"
  // means (D13/D114).
  const data = dataForWorkspace("ws_ignored_in_mock");
  assert.equal(data.workspaceId, null, "mock mode has no tenant to name");
  assert.ok((await data.searchTraces()).traces.length > 0);
  assert.ok((await data.searchLogs()).logs.length > 0);
  assert.ok((await data.getOverview()).stats.length > 0);
});

test("dataForSession resolves in mock mode with no session and no Postgres present (D114)", async () => {
  // The invariance that lets the demo product boot with neither a database nor
  // a signed-in user: the mode check comes first, so the session — and the auth
  // stack behind it — is never even imported. `OBSTACK_POSTGRES_DSN` is deleted
  // at the top of this file, so a resolution that reached Postgres would throw.
  assert.equal(process.env.OBSTACK_POSTGRES_DSN, undefined);
  const data = await dataForSession();
  assert.equal(data.workspaceId, null);
  assert.ok((await data.searchTraces()).traces.length > 0);
});

test("no session is a refusal, never a default workspace", () => {
  // The deleted `workspaceId` constant WAS the default this refuses to become
  // (D96): with no session there is nothing to scope to, and answering anyway
  // is the cross-tenant read the whole refit exists to make impossible.
  assert.throws(() => dataForSessionContext(null), NoSessionError);
  assert.throws(() => dataForSessionContext(null), /no signed-in session/);
  assert.ok(
    dataForSessionContext({ userId: "u1", orgId: "org1", workspaceId: "ws_a" }),
    "a resolved session must produce a facade",
  );
});
