/**
 * The MCP contract's client-safe half (S8.1 packet §0): the key-scope
 * vocabulary (T1), and the tool registry, the prompt text and the endpoint
 * constants (T2) — ONE definition each, consumed by the settings picker, the
 * server's key module, the `/mcp` route's registration loop, the live page's
 * tools section, the docs page and the drive.
 *
 * CLIENT-SAFE by the `metrics-types.ts` rule (D366) and, like `change-types.ts`,
 * `slo-types.ts` and `incident-types.ts`, with ZERO imports: a client component
 * cannot import a `server-only` module for a type alone (S1.5/D10). The
 * enforcement is machine — `mcp-types.test.ts` asserts
 * `/^import /m.test(source) === false` over this file's own bytes.
 *
 * The scope vocabulary is NOT its own authority (D644): the CHECK clause of
 * `services/ingest/pgmigrations/0014_api_key_scope.sql` is, and the test PARSES
 * the members and the DEFAULT out of that file (the `landing-fence.test.ts`
 * idiom) rather than restating them. The tool list is coupled to the two things
 * it must agree with — `mock/mcp.ts`'s fiction (D647: the seven names they
 * share are spelled identically; `get_pipeline_runs` stays out while
 * `/app/pipelines` is unwired) and the recipe sources the setup tool reads
 * (D665: every target below is a quickstart tab or an available connector).
 */

// ---------------------------------------------------------------- scopes (T1)

/** Which door a key opens (D644): `ingest` sends telemetry; `read` reads the workspace through MCP; `setup` is `read` plus minting `ingest` keys through MCP (D666). */
export type ApiKeyScope = "ingest" | "read" | "setup";

/** The runtime list, in the DDL's order. */
export const API_KEY_SCOPES: readonly ApiKeyScope[] = ["ingest", "read", "setup"];

/** What a key is when nobody says (the column's DEFAULT — every key issued before 0014 is one). */
export const DEFAULT_API_KEY_SCOPE: ApiKeyScope = "ingest";

/** The two scopes the MCP endpoint lets in (D642); only `setup` unlocks the mint (D666). */
export type McpKeyScope = "read" | "setup";
export const MCP_ADMITTED_SCOPES: readonly McpKeyScope[] = ["read", "setup"];

/** One line per scope for the picker and the docs — the same words in both places. */
export const API_KEY_SCOPE_LABELS: Readonly<Record<ApiKeyScope, string>> = {
  ingest: "ingest — sends telemetry (exporters, the collector, the SDKs)",
  read: "read — an agent reads this workspace through MCP",
  setup: "setup — read, plus minting ingest keys through MCP",
};

// -------------------------------------------------------- the endpoint (T2)

/** The path the mock has promised since S3.4 (`<host>/mcp`), served outside the `/app` shell (D640). */
export const MCP_PATH = "/mcp";

/**
 * The address the product prints when no operator override is set (D653): true
 * under `next dev`, the compose stack and a `kubectl port-forward`. The chart's
 * Ingress path sets `OBSTACK_PUBLIC_MCP_ENDPOINT` (the pilot packet's 0.7.0)
 * and `server/mcp-endpoint.ts` prefers it — the `ingest-endpoint.ts` D277
 * shape, never `NEXT_PUBLIC_`, never read at build time.
 */
export const MCP_LOOPBACK_ENDPOINT = "http://localhost:3000/mcp";

/** What the server calls itself in `initialize`; the version is pinned to the web package's own by a test. */
export const MCP_SERVER_NAME = "obstack";
export const MCP_SERVER_VERSION = "0.1.0";

/** D645: per KEY, at the HTTP layer, before the transport — 429 with Retry-After over the line. */
export const MCP_RATE_LIMIT = { max: 120, windowMs: 60_000 } as const;

/** D666: a key minted through MCP is named so the settings list shows where it came from. */
export const MCP_KEY_NAME_PREFIX = "mcp:";

// ------------------------------------------------------------ the tools (T2)

/** Twelve reads over the frozen query contracts (D648) and three setup tools (D665–D667). */
export type McpToolName =
  | "query_traces"
  | "get_trace"
  | "search_logs"
  | "get_service_map"
  | "list_issues"
  | "list_metrics"
  | "get_metric_series"
  | "get_slo_status"
  | "list_incidents"
  | "get_incident"
  | "list_alerts"
  | "list_changes"
  | "get_setup_recipe"
  | "issue_ingest_key"
  | "check_arrival";

export interface McpToolSpec {
  name: McpToolName;
  /** `read` never writes; `setup` is the agent-driven integration surface (§6), and only `issue_ingest_key` mutates. */
  kind: "read" | "setup";
  description: string;
  example: string;
}

/**
 * THE registry (D647/D649): the server registers exactly these, the live page
 * lists exactly these, the docs page documents exactly these. Descriptions say
 * what a call returns and name no capability the tree lacks — no "root cause",
 * no pipelines (D646/D647).
 */
export const MCP_TOOLS: readonly McpToolSpec[] = [
  {
    name: "query_traces",
    kind: "read",
    description:
      "Search this workspace's traces by status, service, model, latency, cost, free text and window — one page of 200 plus the exact filtered total",
    example: 'query_traces({ status: "error", service: "checkout", rangeMs: 3600000 })',
  },
  {
    name: "get_trace",
    kind: "read",
    description:
      "One trace by id: spans across the api, agent, tool and llm layers, prompts and completions, tokens, cost, correlated logs and Kubernetes events",
    example: 'get_trace({ id: "a3f8c1d92b6e407f" })',
  },
  {
    name: "search_logs",
    kind: "read",
    description:
      "Log lines with a severity floor, an exact pod, trace-only and a window — capped at 200, with the truncation stated",
    example: 'search_logs({ minSeverity: "error", pod: "agent-worker-7d9f", rangeMs: 21600000 })',
  },
  {
    name: "get_service_map",
    kind: "read",
    description: "Current topology: services as nodes with per-edge rates and error percentages",
    example: "get_service_map({})",
  },
  {
    name: "list_issues",
    kind: "read",
    description: "Recurring errors grouped by fingerprint with counts and trends, and the total before the cap",
    example: "list_issues({})",
  },
  {
    name: "list_metrics",
    kind: "read",
    description: "This workspace's metric catalog — every name with its type, as ingested",
    example: "list_metrics({})",
  },
  {
    name: "get_metric_series",
    kind: "read",
    description:
      "A typed metric series over 1h, 6h or 24h with an aggregation, optionally grouped and filtered — an empty bucket is null, never zero",
    example:
      'get_metric_series({ metric: "http.server.request.duration", type: "histogram", range: "6h", agg: "p95", groupBy: null, filters: {} })',
  },
  {
    name: "get_slo_status",
    kind: "read",
    description: "Every objective's status, current percentage, budget burned, counts and last evaluation",
    example: "get_slo_status({})",
  },
  {
    name: "list_incidents",
    kind: "read",
    description: "This workspace's incidents, newest first, with the ongoing count",
    example: "list_incidents({})",
  },
  {
    name: "get_incident",
    kind: "read",
    description:
      "One incident with its timeline stitched at read time from this workspace's alerts, change events and error traces",
    example: 'get_incident({ id: "inc_0f3a9c1e7b2d4e86" })',
  },
  {
    name: "list_alerts",
    kind: "read",
    description: "Alert rules and the most recent evaluated events, newest first",
    example: "list_alerts({ eventLimit: 50 })",
  },
  {
    name: "list_changes",
    kind: "read",
    description:
      "Deploy, config, flag, scale, secret and infra events this workspace's systems posted, newest first",
    example: "list_changes({ limit: 50 })",
  },
  {
    name: "get_setup_recipe",
    kind: "setup",
    description:
      "The exact install and configuration steps for a target — python, typescript, otel, otlp, kubernetes, docker or github-actions — with this deployment's real endpoints",
    example: 'get_setup_recipe({ target: "typescript" })',
  },
  {
    name: "issue_ingest_key",
    kind: "setup",
    description:
      "Mint an ingest key for the app being set up; needs a setup-scoped key; the token is returned once and never again",
    example: 'issue_ingest_key({ name: "checkout-api" })',
  },
  {
    name: "check_arrival",
    kind: "setup",
    description:
      "Whether telemetry has arrived, per key: accepted and dropped counts, the last event time, and the first trace's id",
    example: 'check_arrival({ keyId: "key_0011223344556677" })',
  },
];

export const MCP_TOOL_NAMES: readonly McpToolName[] = MCP_TOOLS.map((t) => t.name);

/**
 * The setup targets (D665): the quickstart's three tabs, the connectors that
 * ship steps, and — since T5 lifted its YAML into `lib/change-types.ts` (D671)
 * — the GitHub Actions deploy step.
 */
export type McpSetupTarget = "python" | "typescript" | "otel" | "otlp" | "kubernetes" | "docker" | "github-actions";
export const MCP_SETUP_TARGETS: readonly McpSetupTarget[] = [
  "python",
  "typescript",
  "otel",
  "otlp",
  "kubernetes",
  "docker",
  "github-actions",
];

// ------------------------------------------------- the client setups (T5)

/** The same two placeholders the mock and the hub print — pinned equal to theirs by test. */
export const MCP_HOST_PLACEHOLDER_ENDPOINT = "<YOUR_OBSTACK_HOST>/mcp";
export const MCP_API_KEY_PLACEHOLDER = "<OBSTACK_API_KEY>";

/** How Claude Code exposes the prompt (D664/D668): dynamic discovery, `/mcp__<server>__<prompt>`. */
export const MCP_SETUP_COMMAND = "/mcp__obstack__setup";

export interface McpClientSetup {
  id: "claude-code" | "claude-desktop" | "cursor";
  label: string;
  snippet: string;
}

/**
 * The three client setups (D654), rendered from a REAL endpoint on the live
 * page and from the host placeholder in the docs — the same three ids, in the
 * same order, as the mock's frozen `mcpSetup`; the token is always the
 * placeholder, because no page prints a token (D98).
 */
export function mcpClientSetups(endpoint: string): McpClientSetup[] {
  const header = `Authorization: Bearer ${MCP_API_KEY_PLACEHOLDER}`;
  const json = (indent: string) =>
    `{\n${indent}"mcpServers": {\n${indent}  "obstack": {\n${indent}    "url": "${endpoint}",\n${indent}    "headers": { "${header.split(": ")[0]}": "${header.split(": ")[1]}" }\n${indent}  }\n${indent}}\n}`;
  return [
    {
      id: "claude-code",
      label: "Claude Code",
      snippet: `claude mcp add --transport http obstack ${endpoint} \\\n  --header "${header}"`,
    },
    { id: "claude-desktop", label: "Claude Desktop", snippet: json("") },
    { id: "cursor", label: "Cursor", snippet: json("") },
  ];
}

// ----------------------------------------------------------- the prompt (T2)

export interface McpPromptArgument {
  name: string;
  description: string;
  required: boolean;
}

export interface McpPromptSpec {
  name: string;
  description: string;
  arguments: readonly McpPromptArgument[];
  /** The procedure, one step per entry — the server sends these as the prompt's message and the docs page renders the same list (D668). */
  steps: readonly string[];
}

/**
 * The one prompt (D668). Claude Code exposes it as `/mcp__obstack__setup`; the
 * agent's own file tools do the editing, obstack does none of it (D664).
 */
export const MCP_PROMPTS: readonly McpPromptSpec[] = [
  {
    name: "setup",
    description:
      "Set obstack up in this repository: pick the target, get the recipe, obtain an ingest key, apply the recipe, run the app and confirm the first trace arrived",
    arguments: [
      {
        name: "target",
        description: "python, typescript, otel, otlp, kubernetes or docker — omit to pick from the repository",
        required: false,
      },
      {
        name: "service",
        description: "the service name to report under — omit to derive one from the repository",
        required: false,
      },
    ],
    steps: [
      "Inspect this repository yourself and pick the setup target: `python` or `typescript` when the app can take the obstack SDK, `otel` when it already exports OpenTelemetry, `otlp` for a plain exporter, `kubernetes` or `docker` for the collector, `github-actions` to record deploys. obstack reads none of your files.",
      "Call `get_setup_recipe` with that target. The recipe carries this deployment's real endpoints; the key in it is a placeholder until the next step.",
      "Obtain an ingest key: if you are connected with a setup-scoped key, call `issue_ingest_key` with a name that says what the key is for; otherwise ask the user to issue an ingest key in Settings → API keys and paste it. Never commit the key — put it in the environment or the secret store.",
      "Apply the recipe: the SDK's init lines first, above every other import; the OTEL variables and the service name exactly as the recipe spells them; the key where the recipe shows its placeholder.",
      "Run the app, exercise one request, then call `check_arrival` for that key up to twelve times, five seconds apart. When its last event time moves, call `get_trace` on the first trace's id and show the layers that landed.",
      "If nothing arrives, report the drop counters from `check_arrival` and check two things: the endpoint is reachable from where the app runs, and the Authorization header carries the key.",
    ],
  },
];

// -------------------------------------------------------- the sentences (T2)

/** D666: what a `read`-scoped caller hears from `issue_ingest_key` — a refusal, not a 401. */
export const MCP_CANNOT_MINT_SENTENCE =
  "this key cannot issue keys — connect with a setup-scoped key from Settings → API keys";

/** D655: the one sentence the live page and the docs say about what is not kept. */
export const MCP_NO_CALL_LOG_SENTENCE = "obstack does not record agent calls";
