// The ONE connector card / category / connect-step definition, used by BOTH
// modes (D204): live surfaces may not import card copy from `@/mock/*`, and two
// definitions of the same product claim WILL diverge. `@/mock/connectors` keeps
// only the fabricated `connectedSources` demo rows (D208).
//
// Every command below names an artifact that exists in this repo or in
// `deploy/compose/docker-compose.yml` — asserted by `connectors.test.ts`, not
// by review. Nothing here promises a hosted endpoint, a chart repository or a
// published collector image: the environment is local compose (U1).
//
// The ingest addresses are PLACEHOLDERS substituted at render (D281 — the
// same mechanism API_KEY_PLACEHOLDER already established): a snippet baked at
// module scope would freeze the loopback defaults into a deployment whose
// operator configured `OBSTACK_PUBLIC_OTLP_*` overrides (D266/D277), handing
// them an address nothing on their deployment listens on. The modal receives
// the server-resolved pair as props and substitutes; with no override the
// substitution yields the same loopback strings every checkout has always
// shown (D215's one definition survives — the defaults still live in
// `@/lib/ingest-endpoint`, resolved through `@/server/ingest-endpoint`).

export type ConnectorCategory =
  | "Cloud"
  | "PaaS"
  | "Containers & K8s"
  | "Databases"
  | "LLM & AI"
  | "Queues & Events"
  | "CI/CD";

export interface ConnectStep {
  title: string;
  body?: string;
  snippet?: string;
}

export interface Connector {
  slug: string;
  name: string;
  category: ConnectorCategory;
  status: "available" | "coming-soon";
  blurb: string;
  /** two-letter mark rendered in mono */
  mark: string;
  markColor: string; // css color token value
  connectSteps?: ConnectStep[];
}

/**
 * The token slot in every snippet. A key issued in the product is shown once
 * and is unrecoverable afterwards (D98), so the definition carries a literal
 * placeholder and the rendering surface interpolates a real token against this
 * exact string (D210 — ConnectModal never issues a key of its own).
 *
 * D214: it appears ONLY in snippets that target this deployment's ingest —
 * today OTLP and Docker. The Helm chart authenticates against its own Postgres,
 * so a token issued here would be 401'd by the chart's ingest.
 */
export const API_KEY_PLACEHOLDER = "<OBSTACK_API_KEY>";

/**
 * D281: endpoint slots, substituted by ConnectModal at render with the
 * server-resolved pair — never rendered as literals. A step whose snippet
 * carries a placeholder for a protocol the deployment does not publish is
 * rendered as an honest absence instead of its snippet (D282).
 */
export const OTLP_HTTP_PLACEHOLDER = "<OBSTACK_OTLP_HTTP_ENDPOINT>";
export const OTLP_GRPC_PLACEHOLDER = "<OBSTACK_OTLP_GRPC_ENDPOINT>";

export const connectors: Connector[] = [
  /* ---------- available in v1 ---------- */
  {
    slug: "otlp",
    name: "OpenTelemetry (OTLP)",
    category: "Containers & K8s",
    status: "available",
    blurb: "Any OTel SDK or collector. Point your exporter at obstack — done.",
    mark: "OT",
    markColor: "var(--color-api)",
    connectSteps: [
      {
        title: "Point your exporter at ingest",
        body: "Works with any language's OTel SDK or an existing collector. The header is URL-encoded — a raw space drops it (D4 wire contract: Authorization: Bearer).",
        snippet: `OTEL_EXPORTER_OTLP_ENDPOINT="${OTLP_HTTP_PLACEHOLDER}"\nOTEL_EXPORTER_OTLP_PROTOCOL="http/protobuf"\nOTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer%20${API_KEY_PLACEHOLDER}"`,
      },
      {
        // D208 ground for the copy change: a port in the title is a product
        // claim, wrong the moment an override names another address — the
        // step stays protocol-named, the address lives in the snippet.
        title: "Or gRPC",
        body: "ingest listens for OTLP traces and logs over both protocols — gRPC and HTTP. No SDK swap, no re-instrumentation.",
        snippet: `OTEL_EXPORTER_OTLP_ENDPOINT="${OTLP_GRPC_PLACEHOLDER}"\nOTEL_EXPORTER_OTLP_PROTOCOL="grpc"\nOTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer%20${API_KEY_PLACEHOLDER}"`,
      },
    ],
  },
  {
    slug: "kubernetes",
    name: "Kubernetes",
    category: "Containers & K8s",
    status: "available",
    blurb: "One DaemonSet tails every container and attaches pod metadata.",
    mark: "K8",
    markColor: "var(--color-infra)",
    connectSteps: [
      {
        title: "Install the chart",
        body: "The chart brings up a self-contained obstack on your cluster — its own ingest, ClickHouse and Postgres — so the telemetry it collects lands in THAT stack, not in this workspace; connecting an external cluster to this deployment's ingest needs a network-reachable endpoint, which is the self-hosted surface M4 builds. The chart lives in this repo (there is no chart repository to add) and runs from this repo's own images, so build and load obstack-ingest:kind and obstack-demo-agent:kind into the cluster first — deploy/helm/obstack/README.md has the exact sequence. 900s covers a cold ClickHouse pull on install; a warm node is done in ~18s.",
        snippet: `helm install obstack deploy/helm/obstack \\\n  --timeout 900s --wait`,
      },
      {
        title: "What runs",
        body: "The obstack-collector DaemonSet on otel/opentelemetry-collector-k8s:0.158.0, running deploy/collector/config.yaml byte-for-byte: it tails container stdout/stderr, enriches with pod, namespace and container identity (k8s_attributes), and ships OTLP to ingest.",
      },
    ],
  },
  {
    slug: "docker",
    name: "Docker",
    category: "Containers & K8s",
    status: "available",
    blurb: "One collector container that tails other containers' Docker logs and ships them as OTLP.",
    mark: "DK",
    markColor: "var(--color-api)",
    connectSteps: [
      {
        title: "Bring up the collector profile",
        body: "Not a bare `docker compose --profile collector up`: filelog's include and exclude are keyed by container ID, and up.sh resolves those IDs before starting the collector.",
        snippet: `OBSTACK_COLLECTOR_API_KEY=${API_KEY_PLACEHOLDER} bash deploy/collector/up.sh`,
      },
      {
        title: "Logs flow automatically",
        body: "The collector runs deploy/collector/config.compose.yaml on otel/opentelemetry-collector-k8s:0.158.0, tails Docker's own json-file container logs, and ships them as OTLP logs. filelog's include is deliberately scoped to the container IDs up.sh resolves rather than the host-wide glob (it shares your Docker daemon) — widen it in config.compose.yaml to tail your own containers. The collector's own OTLP ports come up on 127.0.0.1:5317 (gRPC) and 127.0.0.1:5318 (HTTP).",
      },
      {
        title: "Skip a container that already exports OTLP",
        body: "A container whose SDK ships logs over OTLP should not also have its stdout tailed, or the same line lands twice. up.sh excludes the demo container for exactly this reason — see deploy/collector/README.md.",
      },
    ],
  },

  /* ---------- coming soon ---------- */
  // Vercel and CloudWatch now HAVE receivers — routes on ingest, built and
  // exercised against real requests — and still say "coming soon", which is
  // the honest state and not a stale card (D101/D208): the hosted endpoint a
  // drain or a subscription filter would be pointed at is not public until S5
  // deploys it, and card availability is a product claim in both modes. These
  // two flip when that endpoint exists, not when their code landed. A
  // self-hoster can already use both against their own ingest — the connector
  // docs S4.4 writes say so.
  {
    slug: "vercel",
    name: "Vercel",
    category: "PaaS",
    status: "coming-soon",
    blurb: "Log drains for functions and edge, correlated with their traces.",
    mark: "VC",
    markColor: "var(--color-ink)",
  },
  {
    slug: "aws-cloudwatch",
    name: "AWS CloudWatch Logs",
    category: "Cloud",
    status: "coming-soon",
    blurb: "Subscription filter → forwarder → obstack. Lambda, ECS, anything that logs.",
    mark: "AW",
    markColor: "var(--color-tool)",
  },
  {
    slug: "gcp-logging",
    name: "GCP Cloud Logging",
    category: "Cloud",
    status: "coming-soon",
    blurb: "Log Router sink → obstack, for GKE, Cloud Run and friends.",
    mark: "GC",
    markColor: "var(--color-api)",
  },
  {
    slug: "azure-monitor",
    name: "Azure Monitor",
    category: "Cloud",
    status: "coming-soon",
    blurb: "Diagnostic settings → event hub → obstack.",
    mark: "AZ",
    markColor: "var(--color-api)",
  },
  {
    slug: "railway",
    name: "Railway",
    category: "PaaS",
    status: "coming-soon",
    blurb: "Service logs from every deploy, correlated with your traces.",
    mark: "RW",
    markColor: "var(--color-agent)",
  },
  {
    slug: "flyio",
    name: "Fly.io",
    category: "PaaS",
    status: "coming-soon",
    blurb: "Machine logs via NATS export — every region, one stream.",
    mark: "FL",
    markColor: "var(--color-agent)",
  },
  {
    slug: "render",
    name: "Render",
    category: "PaaS",
    status: "coming-soon",
    blurb: "Log streams from services and cron jobs.",
    mark: "RD",
    markColor: "var(--color-agent)",
  },
  {
    slug: "supabase",
    name: "Supabase",
    category: "Databases",
    status: "coming-soon",
    blurb: "Postgres, auth and edge-function logs from your Supabase project.",
    mark: "SB",
    markColor: "var(--color-infra)",
  },
  {
    slug: "postgres",
    name: "PostgreSQL",
    category: "Databases",
    status: "coming-soon",
    blurb: "Slow-query and error logs, joined to the requests that caused them.",
    mark: "PG",
    markColor: "var(--color-api)",
  },
  {
    slug: "mongodb",
    name: "MongoDB",
    category: "Databases",
    status: "coming-soon",
    blurb: "Atlas log forwarding with query-shape grouping.",
    mark: "MG",
    markColor: "var(--color-infra)",
  },
  {
    slug: "openrouter",
    name: "OpenRouter",
    category: "LLM & AI",
    status: "coming-soon",
    blurb: "Gateway-side capture of every model call — zero code change.",
    mark: "OR",
    markColor: "var(--color-llm)",
  },
  {
    slug: "vercel-ai-gateway",
    name: "Vercel AI Gateway",
    category: "LLM & AI",
    status: "coming-soon",
    blurb: "Provider-agnostic LLM call capture through the gateway.",
    mark: "AG",
    markColor: "var(--color-llm)",
  },
  {
    slug: "kafka",
    name: "Kafka",
    category: "Queues & Events",
    status: "coming-soon",
    blurb: "Broker logs and consumer-lag events.",
    mark: "KF",
    markColor: "var(--color-tool)",
  },
  {
    slug: "redis",
    name: "Redis",
    category: "Queues & Events",
    status: "coming-soon",
    blurb: "Slowlog and keyspace events, correlated with the calls above them.",
    mark: "RS",
    markColor: "var(--color-err)",
  },
  {
    slug: "github-actions",
    name: "GitHub Actions",
    category: "CI/CD",
    status: "coming-soon",
    blurb: "Workflow logs and deploy markers on your trace timeline.",
    mark: "GH",
    markColor: "var(--color-ink)",
  },
  {
    slug: "cloudflare-workers",
    name: "Cloudflare Workers",
    category: "PaaS",
    status: "coming-soon",
    blurb: "Tail workers logs from the edge.",
    mark: "CF",
    markColor: "var(--color-tool)",
  },
];

export const categories: ConnectorCategory[] = [
  "Containers & K8s",
  "Cloud",
  "PaaS",
  "LLM & AI",
  "Databases",
  "Queues & Events",
  "CI/CD",
];
