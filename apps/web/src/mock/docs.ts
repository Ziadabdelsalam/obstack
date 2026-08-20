/** Authored infrastructure docs: deployment guides, runbooks, DR — the infra manual, hosted in-app. */

export type DocBlock =
  | { kind: "p"; text: string }
  | { kind: "steps"; items: string[] }
  | { kind: "code"; lang: string; code: string }
  | { kind: "callout"; tone: "info" | "warn"; text: string }
  | { kind: "link"; label: string; href: string };

export interface DocSection {
  id: string;
  label: string;
}

export interface DocArticle {
  slug: string;
  section: string;
  title: string;
  summary: string;
  owner: string;
  updated: string;
  tags: string[];
  blocks: DocBlock[];
}

export const docSections: DocSection[] = [
  { id: "deployment", label: "deployment" },
  { id: "environments", label: "environments" },
  { id: "runbooks", label: "runbooks" },
  { id: "dr", label: "disaster recovery" },
];

export const docArticles: DocArticle[] = [
  {
    slug: "deploy-pipeline",
    section: "deployment",
    title: "Deploy pipeline & rollback",
    summary: "How a merge to main becomes a prod rollout, and how to undo it in under two minutes.",
    owner: "omar",
    updated: "Aug 8, 2026",
    tags: ["ci/cd", "argo", "rollback"],
    blocks: [
      {
        kind: "p",
        text: "Every service ships the same way: merge to main → GitHub Actions builds and pushes the image → Argo CD syncs the new tag into loopwork-prod. A deploy marker is emitted to obstack at sync time, so every chart on the Overview page can answer “did the deploy do this?”.",
      },
      {
        kind: "steps",
        items: [
          "Merge to main — CI runs tests, builds linux/arm64 image, pushes ghcr.io/loopwork/<service>:<sha>.",
          "Argo CD detects the tag bump in loopwork-infra and starts a rolling update (maxUnavailable: 0).",
          "Readiness gates hold traffic until /healthz passes twice; the rollout auto-pauses if error rate doubles vs. the previous 15 min.",
          "Deploy marker lands on the traces & metrics timelines with the git sha.",
        ],
      },
      {
        kind: "code",
        lang: "bash",
        code: "# roll back a bad deploy (fastest path)\nargo app history loopwork-gateway\nargo app rollback loopwork-gateway <previous-id>\n\n# or pin the previous image directly\nkubectl -n prod set image deploy/gateway gateway=ghcr.io/loopwork/gateway:f4a2c91",
      },
      {
        kind: "callout",
        tone: "warn",
        text: "Rollback rolls back code, not config. If the incident started with a config or flag change, check the Changes feed first — reverting the image alone can leave the system half-fixed.",
      },
      { kind: "link", label: "what changed before this deploy?", href: "/app/changes" },
    ],
  },
  {
    slug: "collector-rollout",
    section: "deployment",
    title: "Collector rollout (DaemonSet)",
    summary: "The obstack collector that ships every container log with pod metadata attached.",
    owner: "ziad",
    updated: "Aug 5, 2026",
    tags: ["otel", "daemonset", "logs"],
    blocks: [
      {
        kind: "p",
        text: "One DaemonSet per cluster tails container stdout/stderr and Kubernetes events, stamps each line with pod, node, and — where present — OpenTelemetry trace context, and ships it to obstack. This is the join that puts container logs inside the request trace.",
      },
      {
        kind: "code",
        lang: "bash",
        // There is no chart repository to add and no published collector image
        // (D214): the chart lives in this repo, so the runbook shows the install
        // that actually works. A copy-pasteable command is a claim even inside
        // demo content — it is the one kind of mock line a reader will run.
        code: "helm install obstack deploy/helm/obstack \\\n  --timeout 900s --wait",
      },
      {
        kind: "steps",
        items: [
          "Verify pods: kubectl get pods — one collector per node, all Running.",
          "Confirm ingest on the Connections page — the kubernetes source should read “ingesting”.",
          "Spot-check the join: open any trace and look for the INFRA lane with pod events.",
        ],
      },
      {
        kind: "callout",
        tone: "info",
        text: "The collector is resource-capped at 200m CPU / 256Mi and drops to sampling under back-pressure — it will never OOM alongside the workload it's watching.",
      },
      { kind: "link", label: "connections — source health", href: "/app/connections" },
    ],
  },
  {
    slug: "prod-topology",
    section: "environments",
    title: "prod-eu-central topology",
    summary: "What actually runs in production: five services, five pods of interest, one Kafka spine.",
    owner: "ziad",
    updated: "Aug 7, 2026",
    tags: ["kubernetes", "topology", "prod"],
    blocks: [
      {
        kind: "p",
        text: "Production is a single EKS cluster in eu-central-1, three nodes. Traffic path: gateway terminates the API, publishes ticket events to Kafka; agent-worker consumes and runs the support-agent loop (classify_intent → search_kb → draft_reply); tools serves KB lookups and customer fetches; notifier sends replies and webhooks.",
      },
      {
        kind: "code",
        lang: "text",
        code: "gateway      2 pods   API edge, publishes to kafka.ticket-events\nagent-worker 4 pods   the agent loop — LLM calls via AI gateway\ntools        2 pods   search_kb / fetch_customer, talks to Postgres\nnotifier     1 pod    email + webhook egress (allowlisted)\nkafka        3 brk    ticket-events, 12 partitions, RF=3",
      },
      {
        kind: "callout",
        tone: "warn",
        text: "agent-worker is the memory-sensitive one: streaming completions buffer in-process. Its 512Mi limit is the most common OOM source — see the agent-worker OOM runbook before raising it.",
      },
      { kind: "link", label: "live view — nodes & pods", href: "/app/infra" },
      { kind: "link", label: "service map", href: "/app/map" },
    ],
  },
  {
    slug: "staging-previews",
    section: "environments",
    title: "Staging & preview environments",
    summary: "Where changes soak before prod, and what preview envs do and don't share.",
    owner: "omar",
    updated: "Jul 30, 2026",
    tags: ["staging", "previews"],
    blocks: [
      {
        kind: "p",
        text: "staging (loopwork-staging) mirrors prod topology at 1/4 scale and replays a 5% sample of anonymized prod traffic. Every PR also gets an ephemeral preview env — app pods only, sharing the staging Kafka and Postgres, torn down on merge.",
      },
      {
        kind: "steps",
        items: [
          "PR opened → preview env pr-<n>.loopwork.dev spins up (~90s).",
          "Merge to main → auto-deploy to staging; soak gate is 30 min of SLO-clean traffic.",
          "Promotion to prod is a manual approve in the pipeline — never automatic on Fridays.",
        ],
      },
      {
        kind: "callout",
        tone: "info",
        text: "Preview envs use the mock LLM provider by default (fixture completions, zero token spend). Set LLM_MODE=live per-env only when the change under test is prompt-shaped.",
      },
    ],
  },
  {
    slug: "runbook-oom",
    section: "runbooks",
    title: "Runbook: agent-worker OOM-kill",
    summary: "Streaming completions eat the 512Mi limit — the INC-42 pattern. Detect, mitigate, fix.",
    owner: "ziad",
    updated: "Aug 9, 2026",
    tags: ["oom", "agent-worker", "inc-42"],
    blocks: [
      {
        kind: "p",
        text: "Symptom: 502s at the gateway, truncated completions, agent-worker restarts with reason OOMKilled. Cause: each streaming run buffers the completion in-process; a burst of long tickets (e.g. a bulk import) stacks buffers past the 512Mi limit.",
      },
      {
        kind: "steps",
        items: [
          "Confirm: Infrastructure page → pod table → agent-worker restarts with OOMKilled; or open the failing trace and read the INFRA lane.",
          "Mitigate: throttle the ingest source (batch-import to 50 tickets/min) — this ended INC-42 in 4 minutes.",
          "Relieve: scale agent-worker to 6 replicas to spread concurrent streams.",
          "Fix forward: cap concurrent streams per pod (MAX_STREAMS=8) rather than raising the memory limit blindly.",
        ],
      },
      {
        kind: "code",
        lang: "bash",
        code: "kubectl -n prod get pods -l app=agent-worker \\\n  -o custom-columns=NAME:.metadata.name,RESTARTS:.status.containerStatuses[0].restartCount\nkubectl -n prod scale deploy/agent-worker --replicas=6",
      },
      {
        kind: "callout",
        tone: "warn",
        text: "Raising the memory limit without a stream cap just moves the cliff. INC-42's post-mortem: the limit was fine, the concurrency was not.",
      },
      { kind: "link", label: "the OOM trace from INC-42", href: "/app/traces/a3f8c1d92b6e407f" },
    ],
  },
  {
    slug: "runbook-kafka-lag",
    section: "runbooks",
    title: "Runbook: Kafka consumer lag",
    summary: "ticket-events lag growing — find out whether it's volume, a stuck partition, or slow consumers.",
    owner: "omar",
    updated: "Aug 4, 2026",
    tags: ["kafka", "lag", "ticket-events"],
    blocks: [
      {
        kind: "p",
        text: "Lag on ticket-events means tickets are arriving faster than agent-worker drains them. Users see delayed replies, not errors — so the alert fires before anyone complains. Triage in this order: volume spike, stuck partition, slow consumer.",
      },
      {
        kind: "steps",
        items: [
          "Check the Overview requests chart — is ingress actually elevated? If yes, it's volume: scale agent-worker.",
          "Per-partition lag: one partition pinned while others drain means a poison message — check the DLQ and skip it.",
          "Uniform slow drain at normal volume means slow consumers — check p95 of the LLM step on the traces page (provider latency drags every run).",
        ],
      },
      {
        kind: "code",
        lang: "bash",
        code: "kafka-consumer-groups --bootstrap-server kafka:9092 \\\n  --group agent-worker --describe   # LAG column, per partition",
      },
      { kind: "link", label: "pipelines — queue depth & DLQ", href: "/app/pipelines" },
    ],
  },
  {
    slug: "runbook-llm-degradation",
    section: "runbooks",
    title: "Runbook: LLM provider degradation",
    summary: "Provider p95 doubles or error rate climbs — reroute before the queue backs up.",
    owner: "ziad",
    updated: "Aug 2, 2026",
    tags: ["llm", "gateway", "failover"],
    blocks: [
      {
        kind: "p",
        text: "All LLM traffic goes through the AI gateway with a primary and a fallback model. Provider incidents show up first as p95 inflation on the LLM spans, then as timeout errors, then as Kafka lag as runs pile up.",
      },
      {
        kind: "steps",
        items: [
          "Confirm it's the provider, not us: LLM span p95 up while tool/API spans are flat.",
          "Flip the gateway to the fallback model (one config change, picked up live).",
          "Watch Evals for a quality dip on the fallback — drafts may need the stricter reviewer prompt.",
          "Revert when the provider status page clears and p95 holds for 15 min.",
        ],
      },
      {
        kind: "callout",
        tone: "info",
        text: "Cost note: the fallback model is ~1.8× per token. The Costs page attributes the delta per customer automatically — expect the margin tiles to move during long failovers.",
      },
      { kind: "link", label: "evals — quality tracking", href: "/app/evals" },
      { kind: "link", label: "costs — per-customer impact", href: "/app/costs" },
    ],
  },
  {
    slug: "runbook-crashloop",
    section: "runbooks",
    title: "Runbook: pod crash-loop triage",
    summary: "CrashLoopBackOff on any service — the 5-minute decision tree.",
    owner: "omar",
    updated: "Jul 28, 2026",
    tags: ["kubernetes", "crashloop"],
    blocks: [
      {
        kind: "steps",
        items: [
          "Read the last exit: kubectl describe pod — exit code 137 is OOM (go to the OOM runbook), 1 is an app error, 0 with restarts is a liveness-probe kill.",
          "App error: the crash log is already in obstack — Logs page, filter by pod name, read the stack trace at the last restart timestamp.",
          "Liveness kill: check whether /healthz depends on a downstream that's actually the sick one (it should not — probes are self-only by convention).",
          "Bad deploy suspected: Changes feed → was there a rollout in the last 30 min? Roll back per the deploy guide.",
        ],
      },
      {
        kind: "callout",
        tone: "warn",
        text: "Never kubectl delete a crash-looping pod to “fix” it before capturing the state — the restart erases the evidence and the next pod will loop the same way.",
      },
      { kind: "link", label: "logs — filter by pod", href: "/app/logs" },
    ],
  },
  {
    slug: "backup-restore",
    section: "dr",
    title: "Backup & restore",
    summary: "What's backed up, how often, and the tested path back.",
    owner: "ziad",
    updated: "Jul 25, 2026",
    tags: ["postgres", "backups", "rpo"],
    blocks: [
      {
        kind: "p",
        text: "Stateful surface is deliberately small: Postgres (tickets, customers, KB) and Kafka (transit only, 72h retention — not backed up, replayable from source systems). Postgres runs continuous WAL archiving plus a nightly full snapshot. RPO ≤ 5 min, tested RTO 40 min.",
      },
      {
        kind: "steps",
        items: [
          "Restores go to a fresh instance, never in place: restore snapshot, replay WAL to the target timestamp.",
          "Point the tools service at the restored instance via config (one env var), verify with read-only traffic.",
          "Promote by flipping the write DSN; keep the old instance for 24h.",
          "Monthly restore drill is a calendar invariant — a backup that hasn't been restored is a hope, not a backup.",
        ],
      },
      {
        kind: "code",
        lang: "bash",
        code: "# point-in-time restore to 5 minutes before the bad migration\npgbackrest --stanza=loopwork restore \\\n  --type=time --target=\"2026-08-10 13:00:00+00\" --delta",
      },
    ],
  },
  {
    slug: "region-failover",
    section: "dr",
    title: "Region failover",
    summary: "Losing eu-central-1: what fails over, what degrades, who decides.",
    owner: "ziad",
    updated: "Jul 22, 2026",
    tags: ["failover", "dns", "eu-west"],
    blocks: [
      {
        kind: "p",
        text: "The warm standby in eu-west-1 runs the full topology at zero replicas with a read replica of Postgres. Failover is a decision, not an automation — it costs a Kafka gap (in-transit tickets are re-pulled from source systems) and it is declared by the on-call lead, not a script.",
      },
      {
        kind: "steps",
        items: [
          "Declare: incident opened, failover called explicitly in the incident channel.",
          "Promote the eu-west read replica to primary; scale the standby deployments up (~6 min to serving).",
          "Flip DNS at the edge (60s TTL) and re-point source-system webhooks.",
          "Backfill: re-pull tickets created during the gap via the zendesk-migration job in incremental mode.",
        ],
      },
      {
        kind: "callout",
        tone: "warn",
        text: "The public status page keeps serving through a region loss — it is hosted off-stack by design. Update it first; users forgive downtime faster than silence.",
      },
      { kind: "link", label: "public status page", href: "/status" },
    ],
  },
];
