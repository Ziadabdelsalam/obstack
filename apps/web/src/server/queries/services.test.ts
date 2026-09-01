import assert from "node:assert/strict";
import test from "node:test";
import { layerOrder } from "@/lib/layers";
import {
  RECENT_ERROR_TRACE_CAP,
  SERVICE_CAP,
  TOP_SPAN_NAME_CAP,
  WINDOW_HOURS,
} from "@/lib/services-types";
import { forWorkspace } from "@/server/clickhouse";
import type { ScopedClickHouse } from "@/server/clickhouse";
import { getService, listServices } from "./services";

// run with: npm test --workspace apps/web -- services
//
// Hermetic (D96/D113), like metrics.test.ts: nothing here needs a live
// ClickHouse. The seeded-server half of the D397 contract — the numbers the
// SQL actually computes — lives in services.integration.test.ts.

// ---- unscoped-SQL tripwire, proven red per table (phase plan §9.3) ---------
//
// `runScoped` (clickhouse.ts) is the ONE mechanism; this proves it covers the
// two tables THIS module reads, since a `services.ts` statement that lost its
// tenancy predicate is a cross-tenant catalog.

test("tripwire: a bare SELECT against obstack.spans is refused before any query runs", async () => {
  const ch = forWorkspace("ws_services_tripwire");
  await assert.rejects(
    ch.queryRows("SELECT service, count() FROM obstack.spans GROUP BY service"),
    /refusing unscoped SQL/,
  );
});

test("tripwire: a bare SELECT against obstack.trace_summaries is refused before any query runs", async () => {
  const ch = forWorkspace("ws_services_tripwire");
  await assert.rejects(
    ch.queryRows("SELECT trace_id FROM obstack.trace_summaries WHERE has(services, {service:String})", {
      service: "gateway",
    }),
    /refusing unscoped SQL/,
  );
});

// ---- what the query layer sends (D113: no query names a workspace) --------

type Call = { sql: string; params: Record<string, unknown> };

function recorder(responder: (sql: string) => unknown[]): { ch: ScopedClickHouse; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    ch: {
      async queryRows<Row>(sql: string, params: Record<string, unknown> = {}): Promise<Row[]> {
        calls.push({ sql, params });
        return responder(sql) as Row[];
      },
    },
  };
}

function assertEveryCallScoped(label: string, calls: Call[]): void {
  assert.ok(calls.length > 0, `${label} issued no statements`);
  for (const call of calls) {
    assert.ok(
      call.sql.includes("{workspace_id:"),
      `${label} sent a statement with no workspace placeholder: ${call.sql.trim().split("\n")[0]}`,
    );
    assert.ok(
      !("workspace_id" in call.params),
      `${label} bound a workspace_id of its own — the scope is the only thing allowed to (D113)`,
    );
    assert.ok(
      !call.sql.includes("FINAL"),
      `${label} used FINAL — the D7 house rule is GROUP BY plus the matching combinator`,
    );
  }
}

/** D394: one fixed window, bound as a parameter — no statement may carry a hard-coded hour count. */
function assertBoundTo24h(label: string, calls: Call[]): void {
  for (const call of calls) {
    assert.ok(
      call.sql.includes("toIntervalHour({window_hours:UInt32})"),
      `${label} sent a statement with no 24h bound: ${call.sql.trim().split("\n")[0]}`,
    );
    assert.equal(call.params.window_hours, WINDOW_HOURS, `${label} bound a window other than ${WINDOW_HOURS}h`);
  }
  assert.equal(WINDOW_HOURS, 24);
}

const LIST_ROW = {
  name: "gateway",
  layer: "api",
  spans: "1440",
  errors: "36",
  p50_ms: 12.5,
  p95_ms: 240,
  cost_usd: 0.5,
  models: ["gpt-4o-mini"],
  last_seen_iso: "2026-09-01T09:30Z",
  total_services: "137",
};

test("listServices: one scoped read over spans, mapped exactly, with the pre-cap total (D402)", async () => {
  const { ch, calls } = recorder((sql) => {
    assert.ok(sql.includes("obstack.spans"), "listServices did not read spans");
    return [LIST_ROW, { ...LIST_ROW, name: "agent-worker", layer: "agent", spans: "720", errors: "0" }];
  });

  const list = await listServices(ch);

  assert.equal(calls.length, 1, "the catalog is ONE read — the total rides the same query (D402)");
  assertEveryCallScoped("listServices", calls);
  assertBoundTo24h("listServices", calls);
  assert.equal(calls[0].params.cap, SERVICE_CAP);
  assert.ok(calls[0].sql.includes("LIMIT {cap:UInt32}"));
  assert.ok(calls[0].sql.includes("count() OVER ()"), "the total must come from the same grouped set as the rows");
  assert.ok(calls[0].sql.includes("ORDER BY span_count DESC, name"), "the cap's ranking is span volume, tie-broken by name");

  assert.deepEqual(list.rows[0], {
    name: "gateway",
    layer: "api",
    spans: 1440,
    // 1440 spans over a 1440-minute window = exactly 1/min.
    spansPerMin: 1,
    // 36 / 1440 = 2.5%.
    errorPct: 2.5,
    p50Ms: 12.5,
    p95Ms: 240,
    costUsd: 0.5,
    models: ["gpt-4o-mini"],
    lastSeenAt: "2026-09-01T09:30Z",
  });
  assert.equal(list.rows[1].errorPct, 0);
  assert.equal(list.rows[1].spansPerMin, 0.5);
  assert.equal(list.totalServices, 137);
});

test("listServices: the layer list is BOUND, never spliced into the statement (D11)", async () => {
  const { ch, calls } = recorder(() => []);
  await listServices(ch);
  assert.deepEqual(calls[0].params.layer_order, layerOrder);
  assert.ok(calls[0].sql.includes("{layer_order:Array(String)}"));
  for (const layer of layerOrder) {
    assert.equal(
      calls[0].sql.includes(`'${layer}'`),
      false,
      `the statement spells "${layer}" out as a literal instead of binding layerOrder`,
    );
  }
});

test("listServices: no rows is no services — never a total the rows cannot account for", async () => {
  const { ch } = recorder(() => []);
  assert.deepEqual(await listServices(ch), { rows: [], totalServices: 0 });
});

test("listServices: a layer outside layerOrder falls back to the enum's own catch-all", async () => {
  const { ch } = recorder(() => [{ ...LIST_ROW, layer: "quantum" }]);
  const list = await listServices(ch);
  assert.equal(list.rows[0].layer, "other");
});

const DETAIL_CALLS = (sql: string): unknown[] => {
  if (sql.includes("obstack.trace_summaries")) {
    return [{ trace_id: "abc123", root_name: "POST /chat", started_iso: "2026-09-01T09:12Z" }];
  }
  if (sql.includes("GROUP BY name")) {
    return [
      { name: "POST /chat", spans: "100", errors: "5", total_names: "42" },
      { name: "chat.completion", spans: "40", errors: "0", total_names: "42" },
    ];
  }
  return [LIST_ROW];
};

test("getService: three scoped reads — the row, its span names, and the summaries' error traces", async () => {
  const { ch, calls } = recorder(DETAIL_CALLS);

  const detail = await getService(ch, "gateway");

  assert.equal(calls.length, 3);
  assertEveryCallScoped("getService", calls);
  assertBoundTo24h("getService", calls);
  for (const call of calls) {
    assert.equal(call.params.service, "gateway", "the service name is bound, on every read");
  }
  assert.equal(calls[1].params.cap, TOP_SPAN_NAME_CAP);
  assert.equal(calls[2].params.cap, RECENT_ERROR_TRACE_CAP);

  // The summaries read carries the whole D7 house rule: merged arrays and sums,
  // grouped at the table's physical key, never FINAL (asserted above).
  const summaries = calls[2].sql;
  assert.ok(summaries.includes("GROUP BY workspace_id, trace_id"));
  assert.ok(summaries.includes("has(groupUniqArrayArray(services), {service:String})"));
  assert.ok(summaries.includes("sum(error_count) > 0"));
  assert.ok(summaries.includes("argMinIfMerge(root_name)"));

  assert.equal(detail?.name, "gateway");
  assert.deepEqual(detail?.topSpanNames, [
    { name: "POST /chat", count: 100, errorPct: 5 },
    { name: "chat.completion", count: 40, errorPct: 0 },
  ]);
  assert.equal(detail?.totalSpanNames, 42);
  assert.deepEqual(detail?.recentErrorTraces, [
    { traceId: "abc123", rootName: "POST /chat", startedAt: "2026-09-01T09:12Z" },
  ]);
});

test("getService: a name the workspace never sent a span from is null, not an empty scorecard", async () => {
  const { ch } = recorder((sql) => (sql.includes("obstack.trace_summaries") ? [] : []));
  assert.equal(await getService(ch, "never-deployed"), null);
});

test("getService: a hostile service name reaches the server as a bound value, never as SQL text (D11)", async () => {
  const hostile = "gateway' OR 1=1 --";
  const { ch, calls } = recorder(DETAIL_CALLS);
  await getService(ch, hostile);
  for (const call of calls) {
    assert.equal(call.sql.includes(hostile), false, "the name was spliced into the statement");
    assert.equal(call.params.service, hostile);
    assert.ok(call.sql.includes("{service:String}"));
  }
});
