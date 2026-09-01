import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { createClient } from "@clickhouse/client";
import { forWorkspace } from "@/server/clickhouse";

// run with: docker compose -f deploy/compose/docker-compose.yml up -d --wait clickhouse
// then:     npm test --workspace apps/web
// (down -v first for a clean volume — see deploy/compose/README.md)
//
// The seeded-ClickHouse half of `activeSeriesCount` (packet §2): real rows in
// `metric_series` (the MV fires synchronously on INSERT into `metric_points` —
// same measured fact `metrics.integration.test.ts` relies on), read through
// the exact "last_seen within the current UTC day" definition `write.go`'s
// boot reconciliation uses. Skips only when no ClickHouse answers; `web.yml`'s
// D36 skip trap fails the job on an unexpected skip.

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

// Never the compose dev default `ws_demo` — the seeding user has no mutation
// grant, so nothing here can be cleaned up afterwards (metrics.integration.test.ts precedent).
const WORKSPACE_ID = `ws_it_cap_${randomBytes(4).toString("hex")}`;

/** A raw `metric_points` row with the house defaults for columns this probe does not care about. */
function point(overrides: {
  workspace_id: string;
  name: string;
  series_hash: number;
  timestamp: string;
}) {
  return {
    type: "gauge",
    unit: "1",
    service: "series-cap-it",
    value: 1,
    is_monotonic: 0,
    bounds: [],
    bucket_counts: [],
    h_sum: 0,
    h_count: 0,
    h_min: 0,
    h_max: 0,
    attributes: {},
    resource_attributes: {},
    ...overrides,
  };
}

const chTimestamp = (d: Date): string => d.toISOString().slice(0, 19).replace("T", " ") + ".000000000";

test("activeSeriesCount: counts series active today, excludes an old series, against a seeded ClickHouse", async (t) => {
  if (!(await clickhouseReachable())) {
    t.skip(`no ClickHouse at ${CLICKHOUSE_URL}; start deploy/compose (down -v first) to run this test`);
    return;
  }

  const { activeSeriesCount } = await import("./series-cap");
  const ch = forWorkspace(WORKSPACE_ID);

  // Baseline: an empty (fresh) workspace has no active series.
  assert.equal(await activeSeriesCount(ch), 0);

  const suffix = randomBytes(6).toString("hex");
  const now = new Date();
  const yesterday = new Date(now.getTime() - 25 * 60 * 60 * 1000); // safely before toStartOfDay(now('UTC'))

  await seed.insert({
    table: "metric_points",
    format: "JSONEachRow",
    values: [
      point({
        workspace_id: WORKSPACE_ID,
        name: `it.active.${suffix}`,
        series_hash: 1,
        timestamp: chTimestamp(now),
      }),
      point({
        workspace_id: WORKSPACE_ID,
        name: `it.stale.${suffix}`,
        series_hash: 2,
        timestamp: chTimestamp(yesterday),
      }),
    ],
  });

  assert.equal(
    await activeSeriesCount(ch),
    1,
    "the series active today must count, and the one last seen over a UTC day ago must not",
  );

  // Cross-tenant isolation: a second workspace with no rows of its own must
  // never see the first workspace's active series (D96/D113).
  const otherWorkspace = forWorkspace(`ws_it_cap_other_${randomBytes(4).toString("hex")}`);
  assert.equal(await activeSeriesCount(otherWorkspace), 0);
});
