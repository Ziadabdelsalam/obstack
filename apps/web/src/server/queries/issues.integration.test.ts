import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { createClient } from "@clickhouse/client";
import { forWorkspace } from "@/server/clickhouse";

// run with: docker compose -f deploy/compose/docker-compose.yml up -d --wait clickhouse
// then:     npm test --workspace apps/web
// (down -v first for a clean volume — see deploy/compose/README.md)
//
// The seeded-ClickHouse half of D399. The fingerprint is SQL and nothing but
// SQL (D399: no TS helper, no parity corpus), so a mocked `ScopedClickHouse`
// cannot say a single true thing about what groups with what — only a real
// engine running the `replaceRegexpAll` chain and `cityHash64` over real rows
// can. Everything below is therefore stated as the observable result D399
// asks for: which seeded spans land in one issue and which do not.
//
// Skips only when no ClickHouse answers; `web.yml`'s D36 skip trap fails the
// job on an unexpected skip, so this file executes on every PR.

const CLICKHOUSE_URL = process.env.CLICKHOUSE_URL ?? "http://127.0.0.1:8123";
const WEB_USER = process.env.CLICKHOUSE_USER ?? "obstack_web";
const WEB_PASSWORD = process.env.CLICKHOUSE_PASSWORD ?? "obstack_web_dev";
const INGEST_PASSWORD =
  process.env.OBSTACK_TEST_CLICKHOUSE_INGEST_PASSWORD ?? "obstack_ingest_dev";

process.env.CLICKHOUSE_URL = CLICKHOUSE_URL;
process.env.CLICKHOUSE_USER = WEB_USER;
process.env.CLICKHOUSE_PASSWORD = WEB_PASSWORD;

const seed = createClient({
  url: CLICKHOUSE_URL,
  username: "obstack_ingest",
  password: INGEST_PASSWORD,
  database: "obstack",
});

async function clickhouseReachable(): Promise<boolean> {
  try {
    return (await seed.ping()).success;
  } catch {
    return false;
  }
}

/**
 * Two workspaces of this run's own, never the compose dev default `ws_demo`
 * (traces.integration.test.ts precedent) — the seeding user has no mutation
 * grant, so nothing here can be cleaned up afterwards. `WORKSPACE_B` is seeded
 * with NOTHING on purpose: an unscoped read would hand it workspace A's
 * issues, which is the only fixture that can tell a scoped read from an
 * unscoped one (D403's house pair).
 */
const WORKSPACE_ID = `ws_it_${randomBytes(4).toString("hex")}`;
const WORKSPACE_B = `ws_itb_${randomBytes(4).toString("hex")}`;

const SERVICE_A = "issues-it-a";
const SERVICE_B = "issues-it-b";

/** `DateTime64(9,'UTC')` wants `'YYYY-MM-DD HH:MM:SS.nnnnnnnnn'` (traces.integration.test.ts's `chTimestamp`). */
function hoursAgo(hours: number): string {
  const at = new Date(Date.now() - hours * 3600 * 1000);
  return `${at.toISOString().slice(0, 19).replace("T", " ")}.000000000`;
}

let nextSpan = 0;

/** An error span with the house defaults for everything a probe below does not care about. */
function span({
  message,
  hours,
  name = "search_kb",
  service = SERVICE_A,
  status_code = "error",
  trace_id = `it${randomBytes(6).toString("hex")}`,
}: {
  message: string;
  hours: number;
  name?: string;
  service?: string;
  status_code?: string;
  trace_id?: string;
}) {
  return {
    workspace_id: WORKSPACE_ID,
    trace_id,
    span_id: `it${String(nextSpan++).padStart(14, "0")}`,
    parent_span_id: "",
    name,
    kind: "internal",
    service,
    layer: "tool",
    start_time: hoursAgo(hours),
    duration_ns: "1000000",
    status_code,
    status_message: message,
  };
}

/** The normalization result the id-variant pair and its service/name siblings all share. */
const TIMEOUT_TITLE = "timeout after <num>ms for order <num>";
const RECENT_TRACE = `it${randomBytes(6).toString("hex")}`;
const STALE_TRACE = `it${randomBytes(6).toString("hex")}`;

test("listIssues (D399) against a seeded ClickHouse", async (t) => {
  if (!(await clickhouseReachable())) {
    t.skip(`no ClickHouse at ${CLICKHOUSE_URL}; start deploy/compose (down -v first) to run this test`);
    return;
  }

  const { listIssues } = await import("./issues");

  await seed.insert({
    table: "spans",
    format: "JSONEachRow",
    values: [
      // (1) the id-variant pair: same service, layer and span name, messages
      //     differing ONLY in a digit run and an 8-hex-char id.
      span({ message: "timeout after 1234ms for order 9f8e7d6c", hours: 1 }),
      span({ message: "timeout after 98ms for order 0a1b2c3d", hours: 2 }),
      // (1b) the same message on a NON-error span: the error filter is what
      //      keeps this out of the count above.
      span({ message: "timeout after 1234ms for order 9f8e7d6c", hours: 1, status_code: "ok" }),
      // (2) same message, other service -> a second issue.
      span({ message: "timeout after 1234ms for order 9f8e7d6c", hours: 1, service: SERVICE_B }),
      // (3) same message and service, other span name -> a third issue.
      span({ message: "timeout after 1234ms for order 9f8e7d6c", hours: 1, name: "kb.lookup" }),
      // (3b) dashed UUIDs collapse as one id, not as five fragments.
      span({ message: "request 3f2504e0-4f89-11d3-9a0c-0305e82c3301 failed", hours: 2, name: "req.dispatch" }),
      span({ message: "request 550e8400-e29b-41d4-a716-446655440000 failed", hours: 3, name: "req.dispatch" }),
      // (4) quoted-string variants merge.
      span({ message: "unhandled: 'connection reset' at edge", hours: 3, name: "edge.proxy" }),
      span({ message: "unhandled: 'broken pipe' at edge", hours: 4, name: "edge.proxy" }),
      // (5) a plain word apart does NOT merge.
      span({ message: "queue full for orders", hours: 2, name: "queue.push" }),
      span({ message: "queue full for invoices", hours: 2, name: "queue.push" }),
      // (6) numeric URL path segments merge.
      span({ message: "GET /api/v1/orders/9912/items returned 500", hours: 2, name: "http.call" }),
      span({ message: "GET /api/v1/orders/7/items returned 500", hours: 3, name: "http.call" }),
      // (6b) digit runs merge whatever their LENGTH: 8 digits are also 8 hex
      //      characters, so the hex rule claims them and the digit rule claims
      //      the 7-digit one — with two placeholders these land in two issues.
      span({ message: "lookup failed for order 12345678", hours: 2, name: "order.lookup" }),
      span({ message: "lookup failed for order 1234567", hours: 3, name: "order.lookup" }),
      // (7) the three status windows, 6h apart.
      span({ message: "stale signature", hours: 7, name: "stale.only" }),
      span({ message: "fresh signature", hours: 1, name: "fresh.only" }),
      span({ message: "straddling signature", hours: 7, name: "both.ends", trace_id: STALE_TRACE }),
      span({ message: "straddling signature", hours: 1, name: "both.ends", trace_id: RECENT_TRACE }),
      // (8) outside the 24h window: the bound, mutation-proven.
      span({ message: "yesterday signature", hours: 25, name: "too.old" }),
    ],
  });

  const { issues, total } = await listIssues(forWorkspace(WORKSPACE_ID));
  const titled = (title: string) => issues.filter((i) => i.title === title);

  await t.test("id-variant messages group into ONE issue with both occurrences", () => {
    const merged = titled(TIMEOUT_TITLE).filter((i) => i.service === SERVICE_A && i.count === 2);
    assert.equal(merged.length, 1, "the digit/hex-id pair did not merge into one issue");
    assert.equal(merged[0].layer, "tool");
    assert.equal(
      merged[0].count,
      2,
      "an `ok` span with the same message was counted — issues are error spans only (D399)",
    );
  });

  await t.test("service and span name each split the group; nothing else in the corpus does", () => {
    const sameTitle = titled(TIMEOUT_TITLE);
    assert.equal(sameTitle.length, 3, "expected three issues sharing the normalized message");
    assert.equal(new Set(sameTitle.map((i) => i.fingerprint)).size, 3, "fingerprints must differ");
    const otherService = sameTitle.filter((i) => i.service === SERVICE_B);
    assert.equal(otherService.length, 1);
    assert.equal(otherService[0].count, 1);
    // The third is the other span name: same service, same title, its own
    // fingerprint and its own single occurrence.
    const sameService = sameTitle.filter((i) => i.service === SERVICE_A);
    assert.deepEqual(
      sameService.map((i) => i.count).sort((a, b) => b - a),
      [2, 1],
    );
  });

  await t.test("quoted strings, UUIDs and numeric URL path segments collapse; a plain word does not", () => {
    const uuids = titled("request <num> failed");
    assert.equal(uuids.length, 1, "the two dashed UUIDs did not merge into one issue");
    assert.equal(uuids[0].count, 2);

    const quoted = titled("unhandled: <str> at edge");
    assert.equal(quoted.length, 1, "the two quoted variants did not merge");
    assert.equal(quoted[0].count, 2);

    const url = titled("GET /api/v<num>/orders/<num>/items returned <num>");
    assert.equal(url.length, 1, "the two numeric path segments did not merge");
    assert.equal(url[0].count, 2);

    // D399 says "differing ONLY in digits" — the length of the digit run is
    // not an exception, and an 8-digit id is what makes that hard (it is also
    // a hex id).
    const lengths = titled("lookup failed for order <num>");
    assert.equal(lengths.length, 1, "an 8-digit id and a 7-digit id did not merge into one issue");
    assert.equal(lengths[0].count, 2);

    assert.equal(titled("queue full for orders").length, 1);
    assert.equal(titled("queue full for invoices").length, 1);
    assert.notEqual(
      titled("queue full for orders")[0].fingerprint,
      titled("queue full for invoices")[0].fingerprint,
      "messages a plain word apart must stay separate issues",
    );
  });

  await t.test("status is the 6h recency rule, and the example trace is the most recent one", () => {
    assert.equal(titled("stale signature")[0].status, "resolved");
    assert.equal(titled("fresh signature")[0].status, "new");
    const straddling = titled("straddling signature")[0];
    assert.equal(straddling.status, "ongoing");
    assert.equal(straddling.count, 2);
    assert.equal(straddling.exampleTraceId, RECENT_TRACE);
    assert.notEqual(straddling.exampleTraceId, STALE_TRACE);
  });

  await t.test("every sparkline is 24 hourly buckets, oldest first, summing to its count", () => {
    for (const issue of issues) {
      assert.equal(issue.spark.length, 24, `${issue.title} has ${issue.spark.length} buckets`);
      assert.equal(
        issue.spark.reduce((a, b) => a + b, 0),
        issue.count,
        `${issue.title}'s sparkline does not sum to its count`,
      );
    }
    // The straddling pair is 6 buckets apart, oldest first: the 7h-old span
    // sits earlier in the array than the 1h-old one.
    const spark = titled("straddling signature")[0].spark;
    const hits = spark.flatMap((v, i) => (v > 0 ? [i] : []));
    assert.equal(hits.length, 2);
    assert.equal(hits[1] - hits[0], 6, "the two occurrences are 6 hourly buckets apart");
  });

  await t.test("a 25h-old error span is outside the window (the bound, mutation-proven)", () => {
    assert.equal(titled("yesterday signature").length, 0);
    // Twelve seeded signatures inside the window, and the count the D402
    // banner would state is the same twelve — not the thirteen a broken bound
    // returns.
    assert.equal(total, 12);
    assert.equal(issues.length, 12);
  });

  await t.test("a second workspace sees none of them (D7/D403)", async () => {
    assert.deepEqual(await listIssues(forWorkspace(WORKSPACE_B)), { issues: [], total: 0 });
  });
});
