# Idea (backlog, unscheduled): Agent-driven integration milestone

- captured: 2026-08-20, user note ("writing this so I don't forget")
- status: IDEA — not a ruled milestone, not in the vision doc's M1–M7 sequence yet

## The idea

Give any AI coding agent (Claude Code, Codex, Cursor, etc.) the capability to **fully integrate obstack into a user's environment on the user's behalf** — instrument the app, wire the SDKs/connectors, configure keys, and verify data flows — rather than the user following onboarding docs by hand.

## Possible vehicles (undecided)

- The **MCP server** already planned at M7 ("mcp — a net-new MCP server component over the query layer", vision doc line 94 / component table line 168). That server is scoped as *query-layer* MCP; this idea would extend it (or add a second surface) with **setup/integration tools**: create workspace, mint API key, emit per-framework instrumentation instructions, verify first trace arrived.
- Or something other than MCP: an agent-readable install skill / AGENTS.md snippet shipped with `obstack-py`/`obstack-js`, a CLI (`obstack init`) an agent can drive, or docs formatted as agent-executable runbooks.

## Existing pieces it would build on

- MCP server component: M7 (vision doc).
- SDKs: `obstack-py` / `obstack-js` name-holds published (D79 discharged).
- Onboarding + Connections hub: landed S3.4 (source health, "waiting for data…" flip — the verification signal an agent could poll).
- DB-backed API keys: S3.2.

## Companion idea: non-OTLP ingestion paths (captured 2026-08-20)

Motivation: OTLP-first is an adoption filter — many teams (incl. the user's day-job project) don't run OTel and won't adopt it to try obstack. Tap what already exists instead of asking for instrumentation. Ordered by user setup cost:

**Tap existing outputs (zero code changes)**
- `obstack-agent`: single binary/container that tails files, journald, or Docker stdout and ships raw lines (Vector/Promtail model). Generalizes the M3 Docker/K8s connectors to bare VMs and on-prem; biggest coverage win.
- Kubernetes DaemonSet: one `kubectl apply`/Helm install scrapes all pod logs cluster-wide with namespace/label metadata — the "automatically read clusters" story.
- Cloud forwarders: Vercel log drains + CloudWatch forwarder (already M4/S5), plus same-shaped receivers for GCP Pub/Sub sinks, Azure Event Hub, Heroku/Fly/Railway drains.

**Tap the existing logging pipeline (config change only)**
- Syslog receiver (enterprise ubiquity).
- Become a sink for shippers already deployed: Fluent Bit / Fluentd / Vector / Logstash HTTP output → obstack URL.
- Elastic bulk-index / Loki push wire-format compatibility: existing shippers switch with only a URL change. Higher build cost, large compat payoff.

**Tap the logging library (one line of code)**
- Handlers/transports/appenders in `obstack-py`/`obstack-js` and beyond: Python `logging` handler, Winston/Pino transport, Logback/Log4j appender, Serilog sink.

**Honesty constraint**: raw log lines carry no trace context, but obstack's core value is correlated traces. Decide early: logs-only sources land as a first-class-but-uncorrelated tier (searchable, timeline by time+source), upgrading to correlated when a `trace_id` is extractable from structured lines (regex/JSON-field extraction recovers correlation often, with zero client changes).

**Tie-in**: the agent-driven-integration idea above is the delivery mechanism — the agent inspects repo/infra, picks the right path (handler vs. DaemonSet vs. drain vs. shipper sink), wires it, and verifies via the S3.4 source-health signal.

**Cloud/managed-platform users (no host for an agent/DaemonSet — Vercel, Lambda, Cloud Run, Fargate, App Service):**
1. *Platform log drains / cloud log routers (zero code, main path)* — AWS: CloudWatch subscription filter → the M4/S5 forwarder (covers Lambda/Fargate/ECS/App Runner in one motion); GCP: Log Router sink → Pub/Sub push → obstack endpoint (Cloud Run/GKE/Functions); Azure: diagnostic settings → Event Hub; PaaS drains: Vercel (planned), Heroku, Fly, Railway. Setup = paste URL + key into the platform console.
2. *SDK transport built for serverless (one line, for correlation)* — the handler path works on serverless only if transports respect invocation lifecycles: flush before Lambda freeze, `waitUntil()` on Vercel/workers, no long-lived background-flusher assumption. Explicit requirement on `obstack-py`/`obstack-js` transports; a naive batching exporter silently drops data.
3. *Pull-based deploy-nothing connectors (hosted obstack only)* — obstack polls CloudWatch Logs / GCP Logging / Vercel APIs with a scoped read-only token; user deploys nothing. Costlier to run; only sensible once obstack is hosted.
- **Gate**: paths 1 and 3 need a public HTTPS ingest endpoint — the same D101 gap that moved drains out of M3. The whole cloud-user story stacks on S5's hosted deployment; no M3/M4 sequencing change.

**Hosting direction (user, 2026-08-20)**: buy a domain, assign it to the Vercel deployment — hosted obstack most probably lives there. Implication for S5 planning: Vercel hosts the web tier only; the ingest service + ClickHouse + Postgres need separate infra. Likely split: `app.<domain>` → Vercel, `ingest.<domain>` → ingest host. The ingest subdomain is the D101 public HTTPS endpoint that unlocks the cloud-user connectors above — the Vercel side alone doesn't provide it.

**S5 hosting options under consideration (2026-08-20, decision input — not ruled):**
- *Option A — Railway for everything*: all four pieces (web Next standalone image, Go ingest, Postgres one-click, ClickHouse container + volume) in one Railway project; private networking between services; `app.<domain>` and `ingest.<domain>` as custom domains. Maps ~1:1 from compose and keeps the S4 same-images constraint honest. Gives up Vercel preview deploys/edge CDN. ClickHouse is single-node on a volume — we own upgrades/backups; ClickHouse Cloud is a wire-compatible later swap. Ingest can't scale to zero (small fixed cost). Est. ~$50–150/mo at launch scale.
- *Option B — GCP + Google for Startups credits*: web → Cloud Run; ingest → Cloud Run with `min-instances: 1` + CPU always allocated (in-memory batching must not freeze) or a small GCE VM; Postgres → Cloud SQL; ClickHouse → GCE VM + persistent disk (self-operated) or ClickHouse Cloud via GCP Marketplace — **verify Marketplace purchases burn committed credits before counting on it**. Credits (verified 2026-08-20, cloud.google.com/startup): Start tier up to ~$2k (unfunded startups, <5 yrs old, no prior GCP credits); Scale tier up to $200k over 2 years (100% of usage to $100k in Y1, 20% to a further $100k in Y2 — requires equity funding pre-seed→Series A; SAFEs count, angel/F&F/grants don't); AI-First tier up to $350k. More ops than Railway; credits expire → cliff at GCP list prices.
- *Portability guard (both options)*: keep everything in the same containers, nothing provider-proprietary (no Pub/Sub-as-internal-bus etc.), so the credit-expiry cliff or any provider change is a migration, not a rewrite. S4's same-images constraint already enforces this — don't erode it at S5.
- *Lean*: apply for GCP credits regardless (application-only cost). ≥$25k landed → GCP worth the ops; $2k tier only → Railway's simplicity wins for a one-person team.

## Next step when picked up

Decide placement at a milestone-planning moment (likely alongside M7 MCP scoping, per D20's shippable-increment seam constraint): one new milestone vs. folding into M7 as an "integration tools" surface of the MCP server.
