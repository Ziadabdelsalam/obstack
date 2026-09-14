import "server-only";
import { z } from "zod";
import { MCP_TOOL_NAMES, type McpToolName } from "@/lib/mcp-types";
import { ok, refusal, type McpContext, type McpToolResult } from "@/server/mcp/context";

/**
 * The handler map (S8.1 D649): typed TOTAL over `McpToolName`, so a name in the
 * registry without a handler here is a compile error and never a runtime
 * "unknown tool". Each entry is a zod face that mirrors its contract's own
 * filter — every field, none invented — and a call into ONE existing export
 * with the contract object returned verbatim (D648).
 *
 * T3 lands `get_trace` end to end and marks the rest `notYet()`: an honest
 * refusal sentence, listed in `NOT_YET_SERVED` so `tools.test.ts` can pin the
 * set — fourteen at T3, ZERO at T4, and never silently in between.
 */
export interface ToolDefinition<Args = unknown> {
  name: McpToolName;
  inputSchema: z.ZodObject<z.ZodRawShape>;
  handler: (args: Args, ctx: McpContext) => Promise<McpToolResult>;
}

const NOT_SERVED_YET = "this tool is not served yet — S8.1 T4 lands it";

const notYetNames: McpToolName[] = [];

function notYet(name: McpToolName): ToolDefinition<Record<string, never>> {
  notYetNames.push(name);
  return {
    name,
    inputSchema: z.object({}),
    handler: async () => refusal(NOT_SERVED_YET),
  };
}

/** D650: the `NO_SUCH_*` sentence shape verbatim — "no <thing> with this id in your workspace". */
export const noSuch = (thing: string) => `no ${thing} with this id in your workspace`;

const getTrace: ToolDefinition<{ id: string }> = {
  name: "get_trace",
  inputSchema: z.object({ id: z.string().min(1).max(64).describe("the trace id, as the product shows it") }),
  async handler({ id }, ctx) {
    const trace = await ctx.data.getTrace(id);
    if (!trace) return refusal(noSuch("trace"));
    return ok(trace as unknown as Record<string, unknown>);
  },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDefinition = ToolDefinition<any>;

export const TOOL_DEFINITIONS: Readonly<Record<McpToolName, AnyDefinition>> = {
  query_traces: notYet("query_traces"),
  get_trace: getTrace,
  search_logs: notYet("search_logs"),
  get_service_map: notYet("get_service_map"),
  list_issues: notYet("list_issues"),
  list_metrics: notYet("list_metrics"),
  get_metric_series: notYet("get_metric_series"),
  get_slo_status: notYet("get_slo_status"),
  list_incidents: notYet("list_incidents"),
  get_incident: notYet("get_incident"),
  list_alerts: notYet("list_alerts"),
  list_changes: notYet("list_changes"),
  get_setup_recipe: notYet("get_setup_recipe"),
  issue_ingest_key: notYet("issue_ingest_key"),
  check_arrival: notYet("check_arrival"),
};

/** The names still answering `NOT_SERVED_YET` — pinned by `tools.test.ts`, owed to zero by T4. */
export const NOT_YET_SERVED: readonly McpToolName[] = MCP_TOOL_NAMES.filter((name) => notYetNames.includes(name));

export { NOT_SERVED_YET };
