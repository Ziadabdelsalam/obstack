import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test, { after } from "node:test";
import { createClient } from "@clickhouse/client";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { API_KEY_PLACEHOLDER } from "@/components/connections/connectors";
import { MCP_CANNOT_MINT_SENTENCE, MCP_KEY_NAME_PREFIX, MCP_TOOL_NAMES } from "@/lib/mcp-types";

/**
 * The endpoint against REAL stores (S8.1 D643/D661's integration half): two
 * workspaces, three keys, seeded rows in Postgres and ClickHouse, and the real
 * route driven by a stock client — tenancy per id tool, one workspace per
 * list, the setup matrix, the arrival flip.
 *
 * Skips only when `OBSTACK_TEST_POSTGRES_DSN` is unset or ClickHouse does not
 * answer (the `api-keys.integration.test.ts` and `traces.integration.test.ts`
 * idioms); with both present a failure is a failure — an integration test with
 * a DSN never degrades to a pass. CI's `web` job supplies both.
 */

const DSN = process.env.OBSTACK_TEST_POSTGRES_DSN;
const CLICKHOUSE_URL = process.env.CLICKHOUSE_URL ?? "http://127.0.0.1:8123";
const INGEST_PASSWORD = process.env.OBSTACK_TEST_CLICKHOUSE_INGEST_PASSWORD ?? "obstack_ingest_dev";
process.env.CLICKHOUSE_URL = CLICKHOUSE_URL;
process.env.CLICKHOUSE_USER = process.env.CLICKHOUSE_USER ?? "obstack_web";
process.env.CLICKHOUSE_PASSWORD = process.env.CLICKHOUSE_PASSWORD ?? "obstack_web_dev";
if (DSN) process.env.OBSTACK_POSTGRES_DSN = DSN;
// `@/server/data` resolves the mode at module load, so the route — which
// imports it — is imported dynamically below, after this line.
process.env.OBSTACK_DATA_MODE = "live";

const seed = createClient({ url: CLICKHOUSE_URL, username: "obstack_ingest", password: INGEST_PASSWORD, database: "obstack" });
async function clickhouseReachable(): Promise<boolean> {
  try {
    return (await seed.ping()).success;
  } catch {
    return false;
  }
}
const skip = DSN ? undefined : "OBSTACK_TEST_POSTGRES_DSN is unset — no Postgres to dial (deploy/compose/README.md)";

const ENDPOINT = "http://obstack.test/mcp";
type Handle = (request: Request) => Promise<Response>;

async function connectedClient(handle: Handle, token: string) {
  const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
    fetch: (url, init) => handle(new Request(url, init)),
  });
  const client = new Client({ name: "mcp-integration", version: "0" });
  await client.connect(transport);
  return client;
}
const text = (r: { content: unknown }) => (r.content as { text: string }[])[0].text;
const structured = <T,>(r: { structuredContent?: unknown }) => r.structuredContent as T;

function chTimestamp(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19).replace("T", " ")}.000000000`;
}
function spanRow(workspaceId: string, traceId: string, spanId: string, startMs: number, over: Record<string, unknown> = {}) {
  return {
    workspace_id: workspaceId,
    trace_id: traceId,
    span_id: spanId,
    parent_span_id: "",
    name: "POST /chat",
    kind: "server",
    service: "mcp-it-agent",
    start_time: chTimestamp(startMs),
    duration_ns: "28000000",
    status_code: "ok",
    status_message: "",
    layer: "api",
    gen_ai_system: "",
    gen_ai_request_model: "",
    gen_ai_response_model: "",
    input_tokens: 0,
    output_tokens: 0,
    cost_usd: 0,
    finish_reason: "",
    prompt: "",
    completion: "",
    k8s_namespace: "mcp-it",
    k8s_pod: "mcp-it-pod",
    k8s_container: "app",
    k8s_node: "",
    attributes: {},
    resource_attributes: {},
    ...over,
  };
}

after(async () => {
  await seed.close();
  if (DSN) (await import("@/server/postgres")).getPool().end();
});

test("S8.1: the real route against real stores — tenancy per tool, the setup matrix, the arrival flip", { skip }, async (t) => {
  if (!(await clickhouseReachable())) {
    t.skip(`no ClickHouse at ${CLICKHOUSE_URL}; start deploy/compose to run the MCP integration test`);
    return;
  }
  const { queryRows, withTransaction } = await import("@/server/postgres");
  const { hashToken, issueApiKey, resolveApiKey } = await import("@/server/api-keys");
  const { createIncident } = await import("@/server/incidents");
  const { createSlo } = await import("@/server/slos");
  const { dataForWorkspace } = await import("@/server/data");
  const { forWorkspace } = await import("@/server/clickhouse");
  const { mcpRequestHandler } = await import("./handler");
  const { POST } = await import("@/app/mcp/route");
  const handle: Handle = (r) => POST(r);

  const tag = randomBytes(6).toString("hex");
  const a = `ws_mcpa_${tag}`;
  const b = `ws_mcpb_${tag}`;
  await queryRows(`INSERT INTO workspaces (id, org_id) VALUES ($1, $2), ($3, $4)`, [a, `org_mcpa_${tag}`, b, `org_mcpb_${tag}`]);
  try {
    const readA = await issueApiKey(a, "agent a", "read", queryRows);
    const setupA = await issueApiKey(a, "agent a setup", "setup", queryRows);
    const readB = await issueApiKey(b, "agent b", "read", queryRows);

    // ---- seed a's rows: one trace, one incident, one change, one SLO, one alert event ----
    const traceId = `mcpit${tag}`;
    const startMs = Date.now() - 60_000;
    await seed.insert({
      table: "spans",
      format: "JSONEachRow",
      values: [
        spanRow(a, traceId, `${tag}0001`, startMs),
        spanRow(a, traceId, `${tag}0002`, startMs + 5, { parent_span_id: `${tag}0001`, name: "agent.run", kind: "internal", layer: "agent" }),
      ],
    });
    const incident = await withTransaction((q) =>
      createIncident(a, { title: "MCP it: chat errors", severity: "warning", summary: "", impact: "", startedAt: new Date(startMs).toISOString() }, q),
    );
    const changeId = `chg_${randomBytes(8).toString("hex")}`;
    await queryRows(
      `INSERT INTO change_events (id, workspace_id, kind, title, who, service, ref, source, link_label, link_href, at)
       VALUES ($1, $2, 'deploy', 'deploy 1', 'mcp-it', 'mcp-it-agent', 'abc1234', 'test', NULL, NULL, $3)`,
      [changeId, a, new Date(startMs - 1_000).toISOString()],
    );
    const slo = await withTransaction((q) =>
      createSlo(a, { name: "MCP it availability", indicator: { kind: "availability", service: null }, target: 99.9, window: "30d", channelId: null }, q),
    );
    const eventId = `evt_${randomBytes(8).toString("hex")}`;
    await queryRows(
      `INSERT INTO alert_events (id, workspace_id, rule_id, slo_id, channel_id, severity, title, detail)
       VALUES ($1, $2, NULL, NULL, NULL, 'warning', 'MCP it: latency', 'p95 over the bar')`,
      [eventId, a],
    );

    // ---- a reads its own rows through the front door ----
    const ca = await connectedClient(handle, readA.token);
    try {
      const { tools } = await ca.listTools();
      assert.deepEqual(tools.map((x) => x.name).sort(), [...MCP_TOOL_NAMES].sort());

      const trace = await ca.callTool({ name: "get_trace", arguments: { id: traceId } });
      assert.equal(trace.isError, undefined, text(trace));
      assert.equal(structured<{ spanCount: number; id: string }>(trace).spanCount, 2, "the seeded trace's two spans");

      const traces = await ca.callTool({ name: "query_traces", arguments: { status: "all" } });
      assert.ok(structured<{ total: number; traces: { id: string }[] }>(traces).traces.some((x) => x.id === traceId));

      const inc = await ca.callTool({ name: "get_incident", arguments: { id: incident.id } });
      assert.equal(inc.isError, undefined, text(inc));
      const incBody = structured<{ incident: { id: string }; timeline: { entries: unknown[]; retentionDays: number } }>(inc);
      assert.equal(incBody.incident.id, incident.id);
      assert.ok(Array.isArray(incBody.timeline.entries));
      assert.ok(incBody.timeline.retentionDays > 0);

      const incidents = await ca.callTool({ name: "list_incidents", arguments: {} });
      assert.equal(structured<{ total: number }>(incidents).total, 1);
      const slos = await ca.callTool({ name: "get_slo_status", arguments: {} });
      assert.deepEqual(structured<{ slos: { id: string }[] }>(slos).slos.map((s) => s.id), [slo.id]);
      const alerts = await ca.callTool({ name: "list_alerts", arguments: { eventLimit: 10 } });
      assert.deepEqual(structured<{ events: { id: string }[] }>(alerts).events.map((e) => e.id), [eventId]);
      const changes = await ca.callTool({ name: "list_changes", arguments: {} });
      assert.deepEqual(structured<{ changes: { id: string }[] }>(changes).changes.map((c) => c.id), [changeId]);
      for (const name of ["get_service_map", "list_issues", "list_metrics", "search_logs"] as const) {
        const r = await ca.callTool({ name, arguments: {} });
        assert.equal(r.isError, undefined, `${name}: ${text(r)}`);
      }

      // The setup surface from a READ key: recipes yes, minting no.
      const recipe = await ca.callTool({ name: "get_setup_recipe", arguments: { target: "typescript" } });
      assert.equal(recipe.isError, undefined, text(recipe));
      const code = structured<{ code: string }>(recipe).code;
      assert.ok(code.includes(API_KEY_PLACEHOLDER), "the recipe carries the key placeholder, never a token (D673)");
      assert.ok(code.includes("OTEL_EXPORTER_OTLP_ENDPOINT="), "the recipe is the quickstart's, with the endpoint line");
      const k8s = await ca.callTool({ name: "get_setup_recipe", arguments: { target: "kubernetes" } });
      assert.ok(structured<{ steps: unknown[] }>(k8s).steps.length > 0);
      const gha = await ca.callTool({ name: "get_setup_recipe", arguments: { target: "github-actions" } });
      assert.equal(gha.isError, undefined, text(gha));
      assert.ok(structured<{ code: string }>(gha).code.includes("/v1/changes"), "D671 (T5): the deploy step is served from the pinned constant");
      const nope = await ca.callTool({ name: "get_setup_recipe", arguments: { target: "nope" } });
      assert.equal(nope.isError, true);
      const refused = await ca.callTool({ name: "issue_ingest_key", arguments: { name: "checkout-api" } });
      assert.equal(refused.isError, true);
      assert.equal(text(refused), MCP_CANNOT_MINT_SENTENCE);

      const before = await ca.callTool({ name: "check_arrival", arguments: {} });
      assert.equal(structured<{ arrived: boolean }>(before).arrived, false, "no ingest has written a health row for a yet");
    } finally {
      await ca.close();
    }

    // ---- b cannot see a: the same tools, the same ids, the not-found sentence ----
    const cb = await connectedClient(handle, readB.token);
    try {
      const trace = await cb.callTool({ name: "get_trace", arguments: { id: traceId } });
      assert.equal(trace.isError, true);
      assert.equal(text(trace), "no trace with this id in your workspace");
      const inc = await cb.callTool({ name: "get_incident", arguments: { id: incident.id } });
      assert.equal(inc.isError, true);
      assert.equal(text(inc), "no incident with this id in your workspace");
      assert.equal(structured<{ total: number }>(await cb.callTool({ name: "list_incidents", arguments: {} })).total, 0);
      assert.deepEqual(structured<{ slos: unknown[] }>(await cb.callTool({ name: "get_slo_status", arguments: {} })).slos, []);
      assert.deepEqual(structured<{ events: unknown[] }>(await cb.callTool({ name: "list_alerts", arguments: {} })).events, []);
      assert.deepEqual(structured<{ changes: unknown[] }>(await cb.callTool({ name: "list_changes", arguments: {} })).changes, []);
      const traces = await cb.callTool({ name: "query_traces", arguments: {} });
      assert.equal(structured<{ traces: { id: string }[] }>(traces).traces.some((x) => x.id === traceId), false);
    } finally {
      await cb.close();
    }

    // ---- RED, in the test's own scratch (D643): the SAME tool with a MIS-SCOPED
    // context returns a's trace to b's key — so the assertions above bite on
    // the scoping and on nothing else.
    const misScoped = mcpRequestHandler({
      mode: "live",
      resolve: (token) => resolveApiKey(token, queryRows),
      contextFor: (key) => ({
        workspaceId: key.workspaceId,
        keyId: key.keyId,
        scope: key.scope,
        data: dataForWorkspace(a), // the defect: a's facade for whoever calls
        ch: forWorkspace(a),
        query: queryRows,
        nowMs: Date.now(),
      }),
    });
    const red = await connectedClient(misScoped, readB.token);
    try {
      const leak = await red.callTool({ name: "get_trace", arguments: { id: traceId } });
      assert.equal(leak.isError, undefined, "the mis-scoped scratch handler did not leak — the red is not red");
      assert.equal(structured<{ id: string }>(leak).id, traceId);
    } finally {
      await red.close();
    }

    // ---- the setup key mints, and the minted key opens only the ingest door ----
    const cs = await connectedClient(handle, setupA.token);
    try {
      const minted = await cs.callTool({ name: "issue_ingest_key", arguments: { name: "checkout-api" } });
      assert.equal(minted.isError, undefined, text(minted));
      const body = structured<{ token: string; key: { id: string; name: string; scope: string }; shownOnce: boolean }>(minted);
      assert.match(body.token, /^ok_live_[0-9a-f]{64}$/);
      assert.equal(body.key.scope, "ingest");
      assert.equal(body.key.name, `${MCP_KEY_NAME_PREFIX}checkout-api`);
      assert.equal(body.shownOnce, true);
      // Ingest's lookup, verbatim (D146 + D644): the minted key resolves there —
      const [row] = await queryRows<{ workspace_id: string }>(
        `SELECT workspace_id FROM api_keys WHERE token_hash = $1 AND revoked_at IS NULL AND scope = 'ingest'`,
        [hashToken(body.token)],
      );
      assert.equal(row?.workspace_id, a);
      // — and NOT at the MCP door.
      assert.equal(await resolveApiKey(body.token, queryRows), null, "a minted ingest key opened the MCP door");
      // The stored row cannot reproduce the token (D98).
      const [stored] = await queryRows<{ json: string }>(`SELECT to_jsonb(k)::text AS json FROM api_keys k WHERE id = $1`, [body.key.id]);
      assert.equal(stored.json.includes(body.token), false);

      // The arrival flip for THAT key alone: the health row ingest would write.
      await queryRows(
        `INSERT INTO api_key_health (key_id, workspace_id, accepted, last_event_at) VALUES ($1, $2, 3, now())`,
        [body.key.id, a],
      );
      const arrived = await cs.callTool({ name: "check_arrival", arguments: { keyId: body.key.id } });
      const arrivedBody = structured<{ arrived: boolean; firstTrace: { id: string } | null; keys: { keyId: string; accepted: number; lastEventAt: string | null }[] }>(arrived);
      assert.equal(arrivedBody.arrived, true);
      assert.equal(arrivedBody.keys.length, 1);
      assert.equal(arrivedBody.keys[0].accepted, 3);
      assert.ok(arrivedBody.keys[0].lastEventAt);
      assert.ok(arrivedBody.firstTrace, "the workspace's first trace is named once telemetry arrived");
      const other = await cs.callTool({ name: "check_arrival", arguments: { keyId: readA.key.id } });
      assert.equal(structured<{ arrived: boolean }>(other).arrived, false, "another key's window moved");
      const missing = await cs.callTool({ name: "check_arrival", arguments: { keyId: "key_nope" } });
      assert.equal(missing.isError, true);
      assert.equal(text(missing), "no key with this id in your workspace");
    } finally {
      await cs.close();
    }
  } finally {
    await queryRows(`DELETE FROM workspaces WHERE id IN ($1, $2)`, [a, b]);
  }
});
