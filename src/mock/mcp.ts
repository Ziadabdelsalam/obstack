/** The obstack MCP server: read-only access for the user's own agents. */

export interface McpTool {
  name: string;
  description: string;
  example: string;
}

export const mcpTools: McpTool[] = [
  {
    name: "query_traces",
    description: "Search traces by service, route, status, duration, model, cost, free text",
    example: 'query_traces({ status: "error", route: "/v1/tickets/bulk", last: "1h" })',
  },
  {
    name: "get_trace",
    description: "Full trace by id: spans, prompts, correlated logs, k8s events, pods",
    example: 'get_trace({ id: "a3f8c1d92b6e407f" })',
  },
  {
    name: "search_logs",
    description: "Log lines across all pods with severity, pod and time filters",
    example: 'search_logs({ severity: "error+", pod: "agent-worker-*", last: "6h" })',
  },
  {
    name: "get_service_map",
    description: "Current topology with per-edge rates and error percentages",
    example: "get_service_map({})",
  },
  {
    name: "list_issues",
    description: "Fingerprint-grouped recurring errors with counts and trends",
    example: 'list_issues({ status: "ongoing" })',
  },
  {
    name: "get_incident",
    description: "Incident timeline and (if generated) its root-cause analysis",
    example: 'get_incident({ id: "INC-42" })',
  },
  {
    name: "get_slo_status",
    description: "SLO compliance and error-budget burn",
    example: "get_slo_status({})",
  },
  {
    name: "get_pipeline_runs",
    description: "Scheduled flows, run history and live progress",
    example: 'get_pipeline_runs({ pipeline: "zendesk-migration" })',
  },
  {
    name: "get_metrics",
    description: "Time series: requests, errors, latency percentiles, tokens, cost",
    example: 'get_metrics({ series: ["p95", "errors"], last: "6h" })',
  },
];

export interface McpActivity {
  agent: string;
  tool: string;
  args: string;
  time: string;
}

export const mcpActivity: McpActivity[] = [
  { agent: "claude-code · ziad", tool: "get_incident", args: '{ id: "INC-42" }', time: "4m ago" },
  { agent: "claude-code · ziad", tool: "query_traces", args: '{ status: "error", last: "1h" }', time: "5m ago" },
  { agent: "cursor · omar", tool: "search_logs", args: '{ severity: "error+", pod: "agent-worker-*" }', time: "22m ago" },
  { agent: "claude-code · ziad", tool: "get_trace", args: '{ id: "c9d4e71f3a2b8c56" }', time: "31m ago" },
  { agent: "on-call-bot", tool: "get_slo_status", args: "{}", time: "1h ago" },
];

export const mcpSetup = [
  {
    id: "claude-code",
    label: "Claude Code",
    snippet:
      'claude mcp add obstack \\\n  --transport http https://mcp.obstack.dev \\\n  --header "Authorization: Bearer ob_mcp_read_7k2f…"',
  },
  {
    id: "claude-desktop",
    label: "Claude Desktop",
    snippet:
      '{\n  "mcpServers": {\n    "obstack": {\n      "url": "https://mcp.obstack.dev",\n      "headers": { "Authorization": "Bearer ob_mcp_read_7k2f…" }\n    }\n  }\n}',
  },
  {
    id: "cursor",
    label: "Cursor",
    snippet:
      '{\n  "mcpServers": {\n    "obstack": {\n      "url": "https://mcp.obstack.dev",\n      "headers": { "Authorization": "Bearer ob_mcp_read_7k2f…" }\n    }\n  }\n}',
  },
];
