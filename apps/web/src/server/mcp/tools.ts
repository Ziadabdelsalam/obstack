import "server-only";
import { z } from "zod";
import {
  API_KEY_PLACEHOLDER,
  connectors,
  resolveStepSnippet,
} from "@/components/connections/connectors";
import { snippetsFor } from "@/components/onboarding/snippets";
import { SEVERITY_ORDER } from "@/lib/logs-filter";
import {
  MCP_CANNOT_MINT_SENTENCE,
  MCP_KEY_NAME_PREFIX,
  MCP_SETUP_TARGETS,
  MCP_TOOL_NAMES,
  type McpSetupTarget,
  type McpToolName,
} from "@/lib/mcp-types";
import { VALID_AGGS, type MetricAgg, type MetricSeriesQuery } from "@/lib/metrics-types";
import { listAlertEvents, listAlertRules } from "@/server/alerts";
import { KEY_NAME_MAX, issueApiKey, parseKeyName } from "@/server/api-keys";
import { listChangeEvents } from "@/server/changes";
import { readIncidentTimeline } from "@/server/incident-timeline";
import { getIncident, listIncidents } from "@/server/incidents";
import { resolveIngestEndpoints } from "@/server/ingest-endpoint";
import { getIngestHealth } from "@/server/ingest-health";
import { ok, refusal, type McpContext, type McpToolResult } from "@/server/mcp/context";
import { getOnboardingStatus } from "@/server/onboarding";
import { listIssues } from "@/server/queries/issues";
import { listMetricCatalog, queryMetricSeries } from "@/server/queries/metrics";
import { queryTopology } from "@/server/queries/topology";
import { listSlos } from "@/server/slos";
import { getUsage } from "@/server/usage";

/**
 * The handler map (S8.1 D648/D649/D665–D667): typed TOTAL over `McpToolName`,
 * so a name in the registry without a handler here is a compile error and
 * never a runtime "unknown tool". Each entry is a zod face that mirrors its
 * contract's own filter — every field, none invented — and ONE call into an
 * existing export with the contract object returned verbatim. Array contracts
 * ride under a named key (`{ slos }`, `{ changes }`, `{ metrics }`) because a
 * structured result is an object; nothing inside them is reshaped.
 *
 * Every failure is a product sentence (D650): a miss is the `NO_SUCH_*` shape,
 * a store that cannot be reached is `guard`'s sentence with the cause logged
 * once — never a stack, never SQL, never a host, never a workspace id. The
 * handlers close over `ctx` and see no token; the workspace is a parameter and
 * never ambient (D113/D643).
 */
export interface ToolDefinition<Args = unknown> {
  name: McpToolName;
  inputSchema: z.ZodObject<z.ZodRawShape>;
  handler: (args: Args, ctx: McpContext) => Promise<McpToolResult>;
}

/** D650: the `NO_SUCH_*` sentence shape verbatim — "no <thing> with this id in your workspace". */
export const noSuch = (thing: string) => `no ${thing} with this id in your workspace`;

/** A store the request could not read: one log line naming the tool and the cause, one sentence for the agent. */
async function guard(tool: McpToolName, store: string, read: () => Promise<McpToolResult>): Promise<McpToolResult> {
  try {
    return await read();
  } catch (error) {
    console.error(`[mcp] ${tool}: ${store} did not answer`, error);
    return refusal(`obstack could not read ${store} for this request`);
  }
}

/** The bound every window shares: 30 days, the longest retention any plan holds (D693). */
const RANGE_MS_MAX = 30 * 24 * 60 * 60 * 1000;
/** The list bound the trace page uses (`TRACE_PAGE_SIZE`), applied to the two lists the stores floor but do not cap. */
const LIST_MAX = 200;
const asObject = (value: unknown) => value as Record<string, unknown>;

// ---------------------------------------------------------------- the reads

const queryTraces: ToolDefinition<{
  q?: string;
  status?: "all" | "ok" | "error";
  service?: string;
  model?: string;
  minMs?: number;
  minCostUsd?: number;
  maxCostUsd?: number;
  rangeMs?: number;
  page?: number;
}> = {
  name: "query_traces",
  inputSchema: z.object({
    q: z.string().max(200).optional().describe("free text, per the search contract"),
    status: z.enum(["all", "ok", "error"]).optional(),
    service: z.string().max(200).optional().describe("exact membership in the trace's services"),
    model: z.string().max(200).optional().describe("exact membership in the trace's models"),
    minMs: z.number().int().nonnegative().optional(),
    minCostUsd: z.number().nonnegative().optional(),
    maxCostUsd: z.number().nonnegative().optional(),
    rangeMs: z.number().int().positive().max(RANGE_MS_MAX).optional().describe("window back from now; default 6h"),
    page: z.number().int().positive().optional().describe("1-based page of 200"),
  }),
  handler: (filter, ctx) => guard("query_traces", "the trace store", async () => ok(asObject(await ctx.data.searchTraces(filter)))),
};

const getTrace: ToolDefinition<{ id: string }> = {
  name: "get_trace",
  inputSchema: z.object({ id: z.string().min(1).max(64).describe("the trace id, as the product shows it") }),
  handler: ({ id }, ctx) =>
    guard("get_trace", "the trace store", async () => {
      const trace = await ctx.data.getTrace(id);
      return trace ? ok(asObject(trace)) : refusal(noSuch("trace"));
    }),
};

const searchLogs: ToolDefinition<{
  q?: string;
  minSeverity?: (typeof SEVERITY_ORDER)[number];
  pod?: string;
  onTraceOnly?: boolean;
  rangeMs?: number;
}> = {
  name: "search_logs",
  inputSchema: z.object({
    q: z.string().max(200).optional().describe("free text over the log body"),
    minSeverity: z.enum(SEVERITY_ORDER as unknown as [string, ...string[]]).optional().describe("severity floor"),
    pod: z.string().max(253).optional().describe("exact pod name"),
    onTraceOnly: z.boolean().optional().describe("only lines carrying a trace id"),
    rangeMs: z.number().int().positive().max(RANGE_MS_MAX).optional(),
  }),
  handler: (filter, ctx) => guard("search_logs", "the log store", async () => ok(asObject(await ctx.data.searchLogs(filter)))),
};

const getServiceMap: ToolDefinition<Record<string, never>> = {
  name: "get_service_map",
  inputSchema: z.object({}),
  handler: (_args, ctx) => guard("get_service_map", "the trace store", async () => ok(asObject(await queryTopology(ctx.ch)))),
};

const listIssuesTool: ToolDefinition<Record<string, never>> = {
  name: "list_issues",
  inputSchema: z.object({}),
  handler: (_args, ctx) => guard("list_issues", "the trace store", async () => ok(asObject(await listIssues(ctx.ch)))),
};

const listMetrics: ToolDefinition<Record<string, never>> = {
  name: "list_metrics",
  inputSchema: z.object({}),
  handler: (_args, ctx) =>
    guard("list_metrics", "the metrics store", async () => ok({ metrics: await listMetricCatalog(ctx.ch) })),
};

const METRIC_AGGS = ["avg", "min", "max", "last", "sum", "rate", "p50", "p90", "p95", "p99"] as const satisfies readonly MetricAgg[];

const getMetricSeries: ToolDefinition<MetricSeriesQuery> = {
  name: "get_metric_series",
  inputSchema: z.object({
    metric: z.string().min(1).max(200),
    type: z.enum(["gauge", "sum", "histogram"]).describe("REQUIRED — the catalog's type for the name (D384)"),
    range: z.enum(["1h", "6h", "24h"]),
    agg: z.enum(METRIC_AGGS),
    groupBy: z.string().max(200).nullable().default(null).describe("an attribute to group by, or null"),
    filters: z.record(z.string().max(200), z.string().max(500)).default({}).describe("attribute equals value"),
  }),
  handler: (q, ctx) => {
    // The contract's own request error, stated before the store is asked
    // (D363 §0): an aggregation the type cannot take is a product sentence.
    if (!VALID_AGGS[q.type].includes(q.agg)) {
      return Promise.resolve(refusal(`invalid aggregation "${q.agg}" for metric "${q.metric}" (type "${q.type}")`));
    }
    return guard("get_metric_series", "the metrics store", async () => ok(asObject(await queryMetricSeries(ctx.ch, q))));
  },
};

const getSloStatus: ToolDefinition<Record<string, never>> = {
  name: "get_slo_status",
  inputSchema: z.object({}),
  handler: (_args, ctx) => guard("get_slo_status", "the SLO store", async () => ok({ slos: await listSlos(ctx.workspaceId, ctx.query) })),
};

const listIncidentsTool: ToolDefinition<Record<string, never>> = {
  name: "list_incidents",
  inputSchema: z.object({}),
  handler: (_args, ctx) =>
    guard("list_incidents", "the incident store", async () => ok(asObject(await listIncidents(ctx.workspaceId, ctx.query)))),
};

const getIncidentTool: ToolDefinition<{ id: string }> = {
  name: "get_incident",
  inputSchema: z.object({ id: z.string().min(1).max(64) }),
  handler: ({ id }, ctx) =>
    guard("get_incident", "the incident store", async () => {
      const incident = await getIncident(ctx.workspaceId, id, ctx.query);
      if (!incident) return refusal(noSuch("incident"));
      // The incident page's own two trips (D530): the row, then the stitch
      // under the plan's retention floor — the same clock, the same legs.
      const usage = await getUsage(ctx.workspaceId, ctx.query);
      const timeline = await readIncidentTimeline(
        ctx.workspaceId,
        incident,
        usage.retentionDays,
        usage.planName,
        ctx.ch,
        ctx.query,
      );
      return ok({ incident, timeline });
    }),
};

const listAlerts: ToolDefinition<{ eventLimit: number }> = {
  name: "list_alerts",
  inputSchema: z.object({
    eventLimit: z.number().int().min(1).max(LIST_MAX).default(50).describe("how many recent events, newest first"),
  }),
  handler: ({ eventLimit }, ctx) =>
    guard("list_alerts", "the alert store", async () => {
      const [rules, events] = await Promise.all([
        listAlertRules(ctx.workspaceId, ctx.query),
        listAlertEvents(ctx.workspaceId, eventLimit, ctx.query),
      ]);
      return ok({ rules, events });
    }),
};

const listChanges: ToolDefinition<{ limit: number }> = {
  name: "list_changes",
  inputSchema: z.object({
    limit: z.number().int().min(1).max(LIST_MAX).default(50).describe("how many events, newest first"),
  }),
  handler: ({ limit }, ctx) =>
    guard("list_changes", "the change store", async () => ok({ changes: await listChangeEvents(ctx.workspaceId, limit, ctx.query) })),
};

// ----------------------------------------------------------------- the setup

/** D671: the change-events recipe is a docs page until T5 lifts its YAML into a constant. */
const GITHUB_ACTIONS_ABSENCE =
  "the change-events recipe is not served here yet — read it at /docs/connectors/github-actions";

const getSetupRecipe: ToolDefinition<{ target: string }> = {
  name: "get_setup_recipe",
  inputSchema: z.object({
    target: z.string().min(1).max(40).describe(`one of: ${MCP_SETUP_TARGETS.join(", ")}`),
  }),
  async handler({ target }) {
    if (target === "github-actions") return refusal(GITHUB_ACTIONS_ABSENCE);
    if (!(MCP_SETUP_TARGETS as readonly string[]).includes(target)) {
      return refusal(`no recipe for "${target}" — the targets are ${MCP_SETUP_TARGETS.join(", ")}`);
    }
    // The deployment's REAL endpoints (D277) and the key placeholder — D673:
    // the placeholder stays and the agent substitutes the key it holds; a
    // token never travels in a tool argument or a recipe body.
    const endpoints = resolveIngestEndpoints();
    const tab = snippetsFor(API_KEY_PLACEHOLDER, endpoints).find((t) => t.id === target);
    if (tab) {
      if (tab.absence) return refusal(tab.absence);
      return ok({ target: target as McpSetupTarget, kind: "sdk", label: tab.label, code: tab.code, keyPlaceholder: API_KEY_PLACEHOLDER });
    }
    const connector = connectors.find((c) => c.slug === target);
    if (!connector || connector.status !== "available" || !connector.connectSteps?.length) {
      return refusal(`no recipe for "${target}" — the targets are ${MCP_SETUP_TARGETS.join(", ")}`);
    }
    const steps = connector.connectSteps.map((step) => {
      if (!step.snippet) return { title: step.title, body: step.body ?? null, code: null, absence: null };
      const resolved = resolveStepSnippet(step.snippet, endpoints);
      return "code" in resolved
        ? { title: step.title, body: step.body ?? null, code: resolved.code, absence: null }
        : { title: step.title, body: step.body ?? null, code: null, absence: resolved.absence };
    });
    return ok({ target: target as McpSetupTarget, kind: "connector", label: connector.name, steps, keyPlaceholder: API_KEY_PLACEHOLDER });
  },
};

const issueIngestKey: ToolDefinition<{ name: string }> = {
  name: "issue_ingest_key",
  inputSchema: z.object({
    name: z.string().min(1).max(KEY_NAME_MAX - MCP_KEY_NAME_PREFIX.length).describe("what the key is for, e.g. checkout-api"),
  }),
  async handler({ name }, ctx) {
    // D666: the one mutation, gated on the scope — a refusal, never a 401 (the
    // caller is authenticated, just not allowed).
    if (ctx.scope !== "setup") return refusal(MCP_CANNOT_MINT_SENTENCE);
    const parsed = parseKeyName(`${MCP_KEY_NAME_PREFIX}${name}`);
    if (!parsed) return refusal(`give the key a name — 1 to ${KEY_NAME_MAX - MCP_KEY_NAME_PREFIX.length} characters`);
    return guard("issue_ingest_key", "the key store", async () => {
      // Always an `ingest` key: a setup key mints the credential the app exports
      // with and nothing that reads or sets up. Shown once, here (D98).
      const { token, key } = await issueApiKey(ctx.workspaceId, parsed, "ingest", ctx.query);
      return ok({
        token,
        key: { id: key.id, name: key.name, prefix: key.prefix, scope: key.scope, createdAt: key.createdAt.toISOString() },
        shownOnce: true,
      });
    });
  },
};

const checkArrival: ToolDefinition<{ keyId?: string }> = {
  name: "check_arrival",
  inputSchema: z.object({ keyId: z.string().min(1).max(64).optional().describe("narrow to one key") }),
  handler: ({ keyId }, ctx) =>
    guard("check_arrival", "the health store", async () => {
      const [status, health] = await Promise.all([
        getOnboardingStatus(ctx.workspaceId, ctx.data, ctx.query),
        getIngestHealth(ctx.workspaceId, ctx.query),
      ]);
      const keys = (keyId ? health.keys.filter((k) => k.keyId === keyId) : health.keys).map((k) => ({
        keyId: k.keyId,
        name: k.name,
        prefix: k.prefix,
        revoked: k.revoked,
        accepted: k.accepted,
        droppedDecode: k.droppedDecode,
        droppedUnsupported: k.droppedUnsupported,
        droppedQuota: k.droppedQuota,
        droppedCardinality: k.droppedCardinality,
        lastEventAt: k.lastEventAt ? k.lastEventAt.toISOString() : null,
      }));
      if (keyId && keys.length === 0) return refusal(noSuch("key"));
      return ok({
        arrived: keyId ? keys.some((k) => k.lastEventAt !== null) : status.arrived,
        firstTrace: status.firstTrace,
        asOf: health.asOf ? health.asOf.toISOString() : null,
        keys,
      });
    }),
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDefinition = ToolDefinition<any>;

export const TOOL_DEFINITIONS: Readonly<Record<McpToolName, AnyDefinition>> = {
  query_traces: queryTraces,
  get_trace: getTrace,
  search_logs: searchLogs,
  get_service_map: getServiceMap,
  list_issues: listIssuesTool,
  list_metrics: listMetrics,
  get_metric_series: getMetricSeries,
  get_slo_status: getSloStatus,
  list_incidents: listIncidentsTool,
  get_incident: getIncidentTool,
  list_alerts: listAlerts,
  list_changes: listChanges,
  get_setup_recipe: getSetupRecipe,
  issue_ingest_key: issueIngestKey,
  check_arrival: checkArrival,
};

/** T3's `notYet()` set — empty since T4, and `tools.test.ts` pins it empty. */
export const NOT_YET_SERVED: readonly McpToolName[] = MCP_TOOL_NAMES.filter((name) => !(name in TOOL_DEFINITIONS));
export { GITHUB_ACTIONS_ABSENCE };
