# Idea (backlog, registered for the M5-planning packet): Agent evaluation — capture everything an LLM/agent does, score it, watch it
- captured: 2026-08-30, user request during the S4.3 run ("for the parts related to llms or ai agents i want to have this added to the platform so that we are capturing everything they do")
- status: IDEA with a survey attached — not a ruled milestone. The PRD already places evaluation at **Phase 4 "Learn" = M7** and alerting at **Phase 2 "Watch" = M6**; this doc records what the user asked for, what the platform already does, what a design would have to escalate, and the placement options for the advisor at the next planning moment. It does NOT enter S4.3/S4.4/S5 (D13: the docs sprint documents only what exists; D31: scope is the user's call, sequencing is the advisor's).
- survey: read-only Opus pass on `s4.3-obstack-js-launch-alignment` @ `ca9e386`, 2026-08-30; every claim below carries its file:line.

## The idea (verbatim shape)

```
              User Request
                    ↓
                 Agent
                    ↓
         ┌──────────────────┐
         │ Trace Collection │
         └──────────────────┘
                    ↓
    ┌───────────────┼────────────────┐
    ↓               ↓                ↓
 Final Output    Tool Calls      Performance
 Evaluation     Evaluation      Metrics
    ↓               ↓                ↓
 Correctness     Correct tool      Latency
 Groundedness    Correct args      Cost
 Relevance       Efficiency         Tokens
 Safety          Safety             Errors
                    ↓
             Evaluation Pipeline
                    ↓
        Dashboard + Alerts + Analysis
```

Read as a product: for every agent trace obstack already collects, add (1) a scoring layer over the agent's final output, (2) a scoring layer over its tool calls, (3) the performance branch (already the product), (4) a pipeline that runs the scorers on live traffic, and (5) surfaces — an evals dashboard, alerts on score regressions, and analysis.

## What exists today, box by box (measured)

| box | state | ground |
|---|---|---|
| **Performance — latency** | **EXISTS** | `duration_ns` per span (`services/ingest/migrations/0001_spans.sql:14`); `min_start`/`max_end` per trace (`0003_trace_summaries.sql:21-22`) |
| **Performance — cost** | **EXISTS** | computed at ingest, LLM spans only, from `services/ingest/pricing/prices.json` (`internal/mapping/spans.go:86-99`); `total_cost_usd` per trace (`0003:27`); unknown model → `0` + `obstack_ingest_unpriced_models_total` |
| **Performance — tokens** | **EXISTS** | `input_tokens`/`output_tokens` (`0001:26-27`), summed per trace (`0003:25-26`) |
| **Performance — errors** | **EXISTS** | `status_code` Enum8 + `status_message` per span (`0001:15-16`); `error_count` per trace (`0003:24`) |
| Tool calls — correct tool | PARTIAL | the tool **name** is captured (`obstack.tool.name`, `packages/obstack-js/src/helpers.ts:30-32`; py `_decorators.py:10-14`); nothing states which tool was *expected* |
| Tool calls — efficiency | PARTIAL | counts and durations derivable from `spans` + `span_count`; no loop/redundancy detector. The PRD names "agent-loop detection, tool-failure clustering" as **Phase 2 Watch** (`docs/superpowers/specs/2026-08-09-obstack-vision-prd.md:34`) |
| Tool calls — correct args | **ABSENT, and BLOCKED by a standing ruling** | tool arguments and results are captured nowhere and actively deleted by the SDK (`vercel-ai.ts:102-112` — `ai.toolCall.args`, `ai.toolCall.result`, `ai.response.toolCalls` …), by design: "quietly shipping it to a telemetry backend is a PII decision nobody has taken" (`helpers.ts:34-40`). **D78, verbatim: "No input/output capture this sprint (unruled scope, silent PII risk) — documented"** (`.planning/2026-08-17-s2.4-team-plan.md:47`); D78 is the frozen SDK API — "a breaking change is an escalation, not a change" |
| Tool calls — safety | ABSENT | no tool result content stored (same perimeter, D92 `vercel-ai.ts:51-60`) |
| Final output — correctness / relevance | ABSENT | there is no "final output" concept: the trace root carries name/service/method only (`0003:34-36`, `57-59`); the nearest proxy is the last LLM span's `completion` column |
| Final output — groundedness | PARTIAL (inputs only) | the raw material exists — `prompt`/`completion` are stored whole in dedicated ZSTD columns (`0001:32-33`, D82 "content capture is ON by default and full — that IS the product"); no retrieval-context capture, no scorer |
| Final output — safety | ABSENT | no content classification anywhere; security/redaction is M7 (`.planning/2026-08-15-obstack-backend-build-vision.md:167`) |
| Evaluation pipeline | ABSENT | **no scheduler component exists, and inventing one was ruled** "the M6 alert-evaluation shape arriving early" (`.planning/2026-08-23-s4-m4-phase-plan.md:156`); the two fixed-cadence loops that exist (5s metering flush `metering.go:322-344`, 24h retention sweep `retention.go:65`) are explicitly fenced as not that engine (`s4-m4-phase-plan.md:309`) |
| Dashboard | PARTIAL — **fiction** | `/app/evals` already exists pixel-complete on mock data (`apps/web/src/app/app/evals/page.tsx:2, 20, 26-29` — "review confidence 0.91", "regressions 1") behind the D21 SAMPLE badge; not in `liveWiredRoutes` (`lib/live-routes.ts:11-24`) |
| Alerts | ABSENT | zero alert/SLO/incident/burn-rate tables in any migration; no notifier; owned by **M6** (`s4-m4-phase-plan.md:138`) |
| Analysis | PARTIAL | Explain is the one real LLM-analysis path (`apps/web/src/app/app/traces/[id]/explain/route.ts:52`); trace/log search is live |
| **Storage for a verdict** | ABSENT | no writable `(workspace_id, trace_id)` row: `trace_summaries` is MV-fed AggregatingMergeTree never read `FINAL` (`0003:6-10`); **no Postgres table carries a `trace_id`** |

**Net:** the right-hand branch of the diagram is shipped and true today; the middle branch is half-true (names and timing, never arguments); the left branch is absent and its inputs are the one thing the platform deliberately keeps whole. The pipeline, the storage, and the alert path do not exist and two of them are ruled away from M4/M5.

## The metrics the user wants (captured 2026-08-30), mapped to the signal each needs

Unit of measure throughout: a **task = one trace** (root span = the agent's entry) — the only task-shaped unit that exists today (`0003_trace_summaries.sql:34-36`). Anything spanning several traces (a multi-turn session) needs a session/task id attribute that does not exist yet — listed as decision 0 below. "Exists" means computable from the columns on the tree with a query and no new capture.

| # | metric (user's definition) | signal needed | exists today? | what it takes | tier |
|---|---|---|---|---|---|
| 1 | **Task Success Rate** — % of tasks successfully completed | an outcome per task: `succeeded / failed / escalated` | **No.** Only `status_code` (error/ok) on the root span — an *error-free rate*, not success | one additive SDK signal: `obstack.task.outcome` on the root agent span, set by the app (a helper or a return-value convention on `traceAgent`) — D78 additive addition, escalates as such | **1** |
| 2 | **Quality Score** — output quality | a judge over prompt/completion (+ rubric) | No | LLM judge + consent (decision 2) + cost ledger (decision 3) + `trace_scores` (decision 4) | **2** |
| 3 | **Tool Success Rate** — % of tool calls that succeed | tool span status | **Yes** — tool spans carry `status_code`/`status_message` (`0001:15-16`; layer `tool` via `obstack.tool.name`) | a query; verify `traceTool` marks ERROR on throw (fail-open records the exception — confirm at pickup) | **0** |
| 4 | **Tool Selection Accuracy** — did it choose the correct tool? | expected tool (ground truth) or a judge reading the tool's arguments + the step's input | No — only the tool **name** is captured | either (a) an app-supplied expected-tool label (additive attribute), or (b) a judge, which needs **tool args + step input** → the D78 I/O capture escalation (decision 1) | **1(a) / 3(b)** |
| 5 | **Groundedness** — are answers supported by data? | the answer (exists: `completion`), the **retrieval context** (not captured), a judge | Partial — inputs half | context capture (a `retrieval` layer/attribute — additive; the OTel GenAI conventions name `retrieval` as an operation) + judge + consent | **3 + 2** |
| 6 | **Hallucination Rate** — unsupported claims | same as 5, scored per claim | No | judge over completion vs context; without context capture it is only "claims unsupported by the prompt" | **2 (needs 5's capture for the real thing)** |
| 7 | **Latency** — time to complete task | trace duration | **Yes** — `max_end - min_start` per trace (`0003:21-22`), `duration_ns` per span | a query | **0** |
| 8 | **Cost per Task** — cost of running the agent | per-trace cost | **Yes** — `total_cost_usd` (`0003:27`), LLM spans priced at ingest (`spans.go:86-99`) | a query; tool/API cost is not priced (only LLM tokens are) — stated | **0** |
| 9 | **Cost per Successful Task** — efficiency | 8 ÷ 1 | No — the denominator is metric 1 | falls out of 1 | **1** |
| 10 | **Retry Rate** — how often the agent loops/retries | repeated LLM attempts and repeated tool calls within a task | **Partial.** LLM retries: the `ai@7` path emits **one span per retry attempt** (S4.3, verified — `vercel-ai-v7.ts`, "each retry attempt is one span"); repeated same-name tool spans are countable | a query for the countable half; **agent-loop detection** proper (same tool + same args N times, no progress) is the PRD's Phase 2 Watch item (`vision-prd.md:34`) and needs args (decision 1) to tell a loop from legitimate repetition | **0 (count) / M6 (loop detection)** |
| 11 | **Escalation Rate** — how often human help is required | an `escalated` outcome | No | the same outcome signal as metric 1, one more enum value | **1** |
| 12 | **User Satisfaction** — direct production signal | a per-task feedback event from the product (thumbs / rating / comment) attached to a `trace_id` after the fact | No — nothing attaches to a trace after ingest; **no Postgres table carries a `trace_id`** | a feedback ingest path: SDK helper `recordFeedback(traceId, {score, comment?})` or `POST /v1/feedback` on the ingest mux behind the D98 bearer (the S4.2 receiver shape), landing in `trace_scores` with `scorer = 'user'` — never in the attributes Map | **1** |
| 13 | **Safety Violation Rate** — unsafe or unauthorized actions | the **actions** (tool calls with arguments), a policy or judge | No — arguments are deleted by design (`vercel-ai.ts:102-112`) | the D78 I/O capture escalation + M7 security/redaction + a policy engine or judge | **3** |

**Tiers → vehicles.**
- **Tier 0 — a query away today** (3, 7, 8, 10-count): latency, cost per task, tool success rate, retry count per task, plus the error-free rate. These need no capture and no ruling; they need a surface — an "Agents" metrics view over `trace_summaries` + tool spans. Placement lean: **M6 Watch** (it is the same read the alert engine evaluates), or an earlier read-only view if the user wants the numbers before alerts exist — a D31-class call.
- **Tier 1 — one additive SDK signal each** (1, 4a, 9, 11, 12): a **task outcome** attribute and a **feedback** attach path. Both are additive to D78's surface (new helper / new attribute name in `attributes.ts` — D81 — plus one ingest route and one table), both are *capture*, which is M5's lane. **Fold into vehicle B: the M5-planning capture packet carries three items — opt-in tool/agent I/O capture, the task-outcome signal, the feedback attach path.**
- **Tier 2 — needs a judge** (2, 5, 6, 4b): consent + cost ledger + storage + the deterministic-fake CI posture — **M7 Learn**, as the PRD writes it.
- **Tier 3 — needs the D78 I/O capture escalation** (4b, 5-context, 13): decided at M5 planning (vehicle B), scored at M7.

**Decision 0 (new, from this list): the task unit.** If one trace = one task, metrics 1/9/11/12 attach at `(workspace_id, trace_id)`. If an agent task spans traces, an optional `obstack.task.id` attribute (session-class) is the additive answer — same packet as the outcome signal.

## What a design has to decide before anything is built (the escalations, named)

1. **The D78 capture escalation — tool arguments/results and agent step inputs/outputs.** Every "correct args" / "tool safety" / "final output" box needs content the SDKs are frozen not to capture. This is not an extension; the ruling's own clause says it escalates. The honest shape, if it is opened: **opt-in, per-helper, default off** (`traceTool(name, fn, { captureIO: true })`-class, additive to D78's signatures), with the D92 perimeter extended to whatever new column holds it (never the attributes Map — `vercel-ai.ts:95-100`'s "column-less Map forever" argument), a stated redaction posture (M7's security/redaction is the dependency, not an afterthought), and the S4.4 docs sentence ("obstack does not capture tool arguments unless you turn it on") written either way.
2. **Judge consent.** Scoring correctness/groundedness/relevance/safety on live traffic means sending the customer's prompts and completions to a model. **Explain already refused exactly this**: the SQL selects `prompt`/`completion` but `server/explain/prompt.ts:14-17` withholds them — "sending them to a third party is not something an Explain click consented to" — pinned by `explain.test.ts:204-224`. An eval pipeline needs a consent posture Explain did not have: workspace-level opt-in, and the self-hosted `OBSTACK_EXPLAIN_{BASE_URL,MODEL}` override pattern (`server/explain/anthropic.ts:64-70`) so a customer can point the judge at their own endpoint.
3. **Judge cost is metered in tokens/dollars, not runs.** The only precedent counts runs (`plans.explain_quota` free 20 / pro 200, one atomic `SPEND_SQL`, no refund — `server/explain/quota.ts:59-67`, `0006_explain_quota.sql:19-22`); nothing records what an Explain call cost. A pipeline that scores every trace is a continuous spend and needs a ledger row per judge call (tokens in/out, model, cost from `prices.json`), an entitlement per plan, and degradation-not-refusal semantics like ingest's head-sampling (`receive.go:73-80`).
4. **Storage.** A new table — proposal for the packet: ClickHouse `trace_scores (workspace_id, trace_id, scorer, version, score, verdict, evidence_json, judged_at)` ReplacingMergeTree keyed `(workspace_id, trace_id, scorer)`, read by a join at list time — because nothing writable exists at trace grain today and `trace_summaries` must not become writable (`0003:6-16`). Retention rides the D252 sweep.
5. **The pipeline is the M6 scheduler.** A fixed-cadence "score every new trace" loop is the alert-evaluation engine the phase plan fenced out of M4 (`:156`, `:309`). It should arrive **once**, as M6's engine, with evals as its second consumer — not as a third ad-hoc loop beside metering and retention.
6. **Honesty on the surfaces.** `/app/evals` today is labelled sample data (D21). The moment any live score exists, that page either goes live-wired with real numbers or keeps the badge — no mixed state (D125/D208: card availability is a product claim). Same for alerts.
7. **CI never spends (U6).** Every scorer ships with a deterministic fake (the `server/explain/fake.ts` pattern — "not a stub": same prompt assembly, same validation, no credential) and exactly one real-key evidence run per sprint, transcript captured (the S3.5 `-explain-evidence-*` shape).

## Possible vehicles (undecided — the advisor's call at a planning moment)

- **A — keep the PRD's placement.** Watch-half (performance alerts, agent-loop detection, tool-failure clustering, score-regression alerts) = **M6**; Learn-half (final-output + tool-arg scoring, "this deploy made the agent worse", cost recommendations) = **M7**, exactly as `vision-prd.md:34-38` writes it. Nothing pulled forward. Cost: the user's ask waits two milestones.
- **B — pull the capture escalation forward, keep the scoring where it is.** Decide the D78 opt-in I/O capture at **M5 planning** (M5 is Deep Telemetry — capture is in its lane; streaming instrumentation and the JS logging bridge are already its packet, `s4-m4-phase-plan.md:429`), so that by the time M6/M7 score tool calls the data exists with a retention and redaction story behind it. Scoring, pipeline, alerts stay M6/M7. **PM lean: B** — it is the long pole, it is additive, and it is the only part of the diagram that cannot be built later without a data gap.
- **C — a new milestone between M5 and M6.** Refused-by-default under D20's shippable-increment seam: it would batch capture + storage + pipeline + judge + surfaces, the shape every overrun on record had (D28/D94).

## Existing pieces it would build on
- The four-layer trace with whole prompt/completion (`0001_spans.sql:32-33`), layer classification (`mapping.go:75-81`), per-trace summaries (`0003`), cost at ingest (`spans.go:86-99`, `prices.json`).
- `traceAgent`/`traceTool` as the agent/tool layer's only source (`helpers.ts:22-32`; `ai@7` `executeTool` events carry `input`/`output` and were measured in S4.3 — AI6 — and ruled OUT for the same D78 reason, D305).
- Explain: the LLM-call shape (POST-as-spend, atomic quota, NDJSON result/refusal contract, id validation, D248 no-content-in-logs, the deterministic fake, the self-hosted override).
- Metering's add-never-set ledger and the health windows (`0005`, `0007`) as the per-hour accounting shape a judge-cost ledger would copy.
- The `/app/evals` mock (`mock/intelligence`) as the already-designed surface, to be re-labelled or wired, never mixed.

## Next step when picked up
- **Register in the M5-planning packet (this doc is the registration): the capture decisions (vehicle B) — (i) the D78 opt-in tool/agent I/O capture, (ii) the task-outcome signal (`succeeded/failed/escalated`, + optional `obstack.task.id`), (iii) the feedback attach path — decide, do not build, at M5 planning; scoring/pipeline/alerts stay M6/M7 unless the user re-sequences (D31-class).**
- **Tier 0 metrics (latency, cost per task, tool success rate, retry count, error-free rate) are computable today** — the only question is which milestone gets the "Agents" metrics surface (M6 Watch by default; earlier if the user asks — D31).
- Before that packet: nothing to build. The S4.4 docs sprint writes the honest sentences that already apply — "obstack captures what your agent's models said, never your tools' arguments; evaluation is not yet a product surface" — so the launch docs describe the platform as it is.
- Open user question, not blocking anything: is the goal per-trace **scoring** (Learn), or **watching** (alerts on the metrics that already exist — cost/latency/error/token per trace, tool-failure clustering)? The second is M6 and needs no capture escalation; the first is M7 and does.
