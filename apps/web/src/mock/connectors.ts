import type { ConnectedSource, Connector } from "./types";

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
        title: "Set the exporter endpoint",
        body: "Works with any language's OTel SDK or an existing collector.",
        snippet:
          'OTEL_EXPORTER_OTLP_ENDPOINT="https://ingest.obstack.dev"\nOTEL_EXPORTER_OTLP_HEADERS="x-obstack-key=ok_live_9f2e…"',
      },
      {
        title: "Send anything",
        body: "Traces and logs arrive on the standard OTLP ports (4317 gRPC / 4318 HTTP). No SDK swap, no re-instrumentation.",
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
        title: "Install the collector",
        snippet:
          "helm repo add obstack https://charts.obstack.dev\nhelm install obstack-collector obstack/collector \\\n  --set apiKey=ok_live_9f2e… --namespace obstack --create-namespace",
      },
      {
        title: "That's it",
        body: "The DaemonSet tails container stdout/stderr, enriches with pod, namespace and container labels (k8sattributes), and ships OTLP to obstack.",
      },
    ],
  },
  {
    slug: "docker",
    name: "Docker",
    category: "Containers & K8s",
    status: "available",
    blurb: "A single container that ships logs from every other container on the host.",
    mark: "DK",
    markColor: "var(--color-api)",
    connectSteps: [
      {
        title: "Run the collector",
        snippet:
          "docker run -d --name obstack-collector \\\n  -v /var/run/docker.sock:/var/run/docker.sock:ro \\\n  -e OBSTACK_API_KEY=ok_live_9f2e… \\\n  obstack/collector:latest",
      },
      {
        title: "Logs flow automatically",
        body: "Every container on the host is tailed, labeled with container name and image, and shipped as OTLP logs.",
      },
    ],
  },
  {
    slug: "vercel",
    name: "Vercel",
    category: "PaaS",
    status: "available",
    blurb: "Log drains for functions and edge — connected in two clicks.",
    mark: "VC",
    markColor: "var(--color-ink)",
    connectSteps: [
      {
        title: "Add the log drain",
        body: "In your Vercel project: Settings → Log Drains → Add. Paste your obstack drain URL:",
        snippet: "https://ingest.obstack.dev/v1/vercel?key=ok_live_9f2e…",
      },
      {
        title: "Function logs correlate automatically",
        body: "If your functions run OTel (one env var), request IDs join Vercel logs to their traces.",
      },
    ],
  },
  {
    slug: "aws-cloudwatch",
    name: "AWS CloudWatch Logs",
    category: "Cloud",
    status: "available",
    blurb: "Subscription filter → forwarder → obstack. Lambda, ECS, anything that logs.",
    mark: "AW",
    markColor: "var(--color-tool)",
    connectSteps: [
      {
        title: "Deploy the forwarder",
        snippet:
          "aws cloudformation deploy \\\n  --template-url https://cf.obstack.dev/forwarder.yaml \\\n  --stack-name obstack-forwarder \\\n  --parameter-overrides ObstackKey=ok_live_9f2e…",
      },
      {
        title: "Choose log groups",
        body: "Pick the CloudWatch log groups to subscribe. New events stream to obstack within seconds.",
      },
    ],
  },

  /* ---------- coming soon ---------- */
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

export const connectedSources: ConnectedSource[] = [
  {
    connectorSlug: "kubernetes",
    name: "prod-cluster (GKE, 14 nodes)",
    status: "healthy",
    lastEvent: "2s ago",
    ratePerMin: 8420,
    errorCount: 0,
  },
  {
    connectorSlug: "otlp",
    name: "agent-worker · obstack-py",
    status: "healthy",
    lastEvent: "1s ago",
    ratePerMin: 1130,
    errorCount: 0,
  },
  {
    connectorSlug: "vercel",
    name: "loopwork-web (production)",
    status: "degraded",
    lastEvent: "4m ago",
    ratePerMin: 86,
    errorCount: 12,
  },
];

export const categories: Connector["category"][] = [
  "Containers & K8s",
  "Cloud",
  "PaaS",
  "LLM & AI",
  "Databases",
  "Queues & Events",
  "CI/CD",
];
