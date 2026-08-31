import "server-only";
import type {
  K8sEvent,
  Layer,
  LlmDetail,
  LogRecord,
  Severity,
  Span,
  SpanStatus,
  Trace,
} from "@/lib/types";
import { NEARBY_LOG_CAP } from "@/lib/nearby-logs";

/**
 * ClickHouse rows → the view-model types in `src/lib/types.ts` (D12). No new UI
 * types: the product's existing shapes are the contract, and an optional field
 * the pipeline cannot supply for a given trace stays ABSENT rather than being
 * filled with a placeholder. `k8sEvents` is supplied now — from the k8s event
 * rows the collector's `k8s_events` receiver writes, when the deployment ships
 * them and the trace ran on the pods they describe — and omitted, never empty,
 * when it does not. `explanation` remains unset here: it is produced elsewhere
 * (`server/explain/`), not adapted from a row.
 *
 * 64-bit values arrive as strings — every nanosecond quantity is already
 * reduced to an offset or a duration in SQL, so nothing here parses an absolute
 * epoch-ns value that would lose precision as a JS number.
 */

/** One merged `trace_summaries` row: `GROUP BY workspace_id, trace_id` (D7). */
export interface TraceSummaryRow {
  trace_id: string;
  /** exact epoch nanos of `min(min_start)`; opaque — passed straight back as a query param */
  min_start_ns: string;
  started_ms: string;
  duration_ns: string;
  span_count: string;
  error_count: string;
  input_tokens: string;
  output_tokens: string;
  cost_usd: number;
  services: string[];
  models: string[];
  root_name: string;
  root_method: string;
  /** service of the root span, from the summary's `root_service` argMinIf state */
  root_service: string;
}

export interface SpanRow {
  span_id: string;
  parent_span_id: string;
  name: string;
  layer: string;
  service: string;
  /** nanos from the trace's `min_start` */
  start_offset_ns: string;
  duration_ns: string;
  status_code: string;
  status_message: string;
  k8s_pod: string;
  k8s_node: string;
  gen_ai_request_model: string;
  gen_ai_response_model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  finish_reason: string;
  /** D8-AMENDMENT: prompt/completion live in their own columns, never in `attributes` */
  prompt: string;
  completion: string;
  attributes: Record<string, string>;
}

export interface LogRow {
  /** nanos from the trace's `min_start`; negative for logs emitted before it */
  at_offset_ns: string;
  trace_id: string;
  /**
   * The LLM span this row's GenAI content belongs to (D38 FINAL / D42). Only
   * `LOGS_SQL` selects this — `NEARBY_LOGS_SQL` rows always carry `trace_id =
   * ''` and can never be a coalesce candidate for this trace, so it never
   * needs the column.
   */
  span_id?: string;
  severity_number: number;
  severity_text: string;
  body: string;
  /** log-record GenAI content (D38 FINAL / D42); only `LOGS_SQL` selects these */
  prompt?: string;
  completion?: string;
  k8s_namespace: string;
  k8s_pod: string;
  k8s_container: string;
}

/**
 * One Kubernetes event row (`K8S_EVENTS_SQL`). Not a `LogRow`: the identifying
 * fields are read out of the attribute maps in SQL — pod identity arrives as
 * the resource attribute `k8s.object.name`, so the promoted `k8s_pod` column is
 * empty on these rows — and `reason` has no analogue in a log line at all.
 */
export interface K8sEventRow {
  /** `k8s.event.uid`; the query already deduped on it, so it is unique here */
  event_uid: string;
  /** `k8s.event.reason` — the open-ended upstream vocabulary, folded onto `K8sEvent["kind"]` below */
  reason: string;
  /** `k8s.object.name` of the involved Pod */
  pod: string;
  /** nanos from the trace's `min_start`; negative for events before it */
  at_offset_ns: string;
  severity_number: number;
  severity_text: string;
  /** the event message */
  body: string;
}

const nsToMs = (ns: string): number => Number(ns) / 1_000_000;

const LAYERS: readonly string[] = ["api", "agent", "tool", "llm", "infra", "other"];

const toLayer = (value: string): Layer => (LAYERS.includes(value) ? (value as Layer) : "other");

const toStatus = (statusCode: string): SpanStatus => (statusCode === "error" ? "error" : "ok");

/** Maps the open-ended OTel finish reason onto the UI's closed union; unknown → "stop" (D12). */
const FINISH_REASONS: Record<string, LlmDetail["finishReason"]> = {
  stop: "stop",
  end_turn: "stop",
  stop_sequence: "stop",
  length: "length",
  max_tokens: "length",
  truncated: "truncated",
  content_filter: "truncated",
  error: "error",
};

/**
 * D42(d) read-time coalesce: per (span_id, field), the earliest-timestamp log
 * row whose that field is non-empty. `logRows` arrives from `LOGS_SQL`'s
 * `ORDER BY timestamp`, so "earliest" is just "first non-empty match in array
 * order" — first write wins, resolved independently per field so a
 * prompt-only row and a later completion-only row for the same span each fill
 * their own slot. This is the ONLY place multiple content rows for one span
 * get reduced to one candidate value per field; `toLlmDetail` below still
 * decides whether the span's own column beats it.
 */
function eventDerivedFillBySpan(
  logRows: LogRow[],
): Map<string, { prompt?: string; completion?: string }> {
  const bySpan = new Map<string, { prompt?: string; completion?: string }>();
  for (const row of logRows) {
    if (!row.span_id || (!row.prompt && !row.completion)) continue;
    const fill = bySpan.get(row.span_id) ?? {};
    if (row.prompt && fill.prompt === undefined) fill.prompt = row.prompt;
    if (row.completion && fill.completion === undefined) fill.completion = row.completion;
    bySpan.set(row.span_id, fill);
  }
  return bySpan;
}

function toLlmDetail(
  row: SpanRow,
  status: SpanStatus,
  eventFill: { prompt?: string; completion?: string } | undefined,
): LlmDetail {
  return {
    model: row.gen_ai_response_model || row.gen_ai_request_model,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    costUsd: row.cost_usd,
    // D42(d): a non-empty span column always wins; only when it is empty does
    // the earliest event-derived row fill it in, per field independently.
    // Content never enters cost/token computation above — those stay
    // span-attribute-sourced (D9) regardless of which branch fills the text.
    prompt: row.prompt || eventFill?.prompt || "",
    completion: row.completion || eventFill?.completion || "",
    finishReason:
      status === "error" ? "error" : (FINISH_REASONS[row.finish_reason] ?? "stop"),
  };
}

/**
 * `eventFillBySpan` is REQUIRED, not defaulted: a default empty map would let a
 * future caller drop the D42(d) coalesce silently (an event-form-only trace
 * would render a blank prompt and look like missing data), and the compiler
 * would not say a word. Callers with nothing to fill from pass an empty map
 * explicitly.
 */
export function toSpan(
  row: SpanRow,
  traceId: string,
  eventFillBySpan: Map<string, { prompt?: string; completion?: string }>,
): Span {
  const layer = toLayer(row.layer);
  const status = toStatus(row.status_code);
  return {
    id: row.span_id,
    traceId,
    parentId: row.parent_span_id || null,
    name: row.name,
    layer,
    service: row.service,
    pod: row.k8s_pod || undefined,
    node: row.k8s_node || undefined,
    startMs: nsToMs(row.start_offset_ns),
    durationMs: nsToMs(row.duration_ns),
    status,
    statusMessage: row.status_message || undefined,
    attrs: row.attributes,
    llm: layer === "llm" ? toLlmDetail(row, status, eventFillBySpan.get(row.span_id)) : undefined,
  };
}

/**
 * OTel severity numbers: 1-4 TRACE, 5-8 DEBUG, 9-12 INFO, 13-16 WARN, 17-20
 * ERROR, 21+ FATAL. Structurally typed on the two severity columns rather than
 * on `LogRow`, because k8s event rows carry the identical pair and must fold
 * the identical way — one severity ladder for everything ingest writes into
 * `obstack.logs`.
 */
function toSeverity(row: { severity_number: number; severity_text: string }): Severity {
  const n = row.severity_number;
  if (n >= 21) return "fatal";
  if (n >= 17) return "error";
  if (n >= 13) return "warn";
  if (n >= 9) return "info";
  if (n >= 1) return "debug";
  const text = row.severity_text.toLowerCase();
  if (text === "fatal" || text === "critical") return "fatal";
  if (text === "error") return "error";
  if (text === "warn" || text === "warning") return "warn";
  if (text === "debug" || text === "trace") return "debug";
  return "info";
}

export function toLogRecord(row: LogRow, index: number): LogRecord {
  return {
    id: `${row.trace_id}-${index}`,
    traceId: row.trace_id || undefined,
    atMs: nsToMs(row.at_offset_ns),
    severity: toSeverity(row),
    body: row.body,
    namespace: row.k8s_namespace,
    pod: row.k8s_pod,
    // "app" is the rail's sentinel for "the only container", so it stays quiet
    // for telemetry that carries no k8s resource attributes.
    container: row.k8s_container || "app",
  };
}

/**
 * Kubernetes event reason → the UI's `kind` union. Curated on purpose: the
 * upstream vocabulary is open-ended (any controller may invent a reason), so
 * this table names the ones the timeline has a story for and everything else
 * falls to `"other"` — a real marker at a real time with the event's own
 * message, rather than a dropped row or an invented classification.
 *
 * `scale`, `throttle` and `reindex` stay mock-only by construction, not by
 * omission: scaling and throttling events attach to Deployment/HPA/Node
 * objects, which `K8S_EVENTS_SQL`'s `k8s.object.kind = 'Pod'` filter excludes,
 * and `reindex` is not a Kubernetes concept at all.
 */
const EVENT_KINDS: Record<string, K8sEvent["kind"]> = {
  OOMKilling: "oom_kill",
  OOMKilled: "oom_kill",
  BackOff: "restart",
  Unhealthy: "restart",
  Killing: "restart",
};

/**
 * One event row → the infra track's `K8sEvent`.
 *
 * `atMs` is relative to the trace's `min_start` like every other offset in this
 * file (the subtraction happened in SQL, against the exact epoch nanos), and is
 * rounded: an infra event's meaning is "around here on this timeline", and
 * sub-millisecond precision on a kubelet-reported event time would be precision
 * the source does not have.
 *
 * Severity is derived, not copied: an OOM kill is `"fatal"` whatever the
 * receiver labelled it (a `warning`-Type event that killed the container is not
 * a warning to the person reading the trace), and otherwise the row's own OTel
 * severity decides. The receiver only ever emits Info or Warn, but anything at
 * or above the WARN range folds to `"warn"` rather than silently downgrading to
 * `"info"` if that ever changes — `K8sEvent["severity"]` has no error member.
 *
 * `label` is the event message; a bodyless event falls back to its reason so
 * the marker still says what it was.
 */
function toEventSeverity(kind: K8sEvent["kind"], row: K8sEventRow): K8sEvent["severity"] {
  if (kind === "oom_kill") return "fatal";
  const severity = toSeverity(row);
  return severity === "warn" || severity === "error" || severity === "fatal" ? "warn" : "info";
}

export function toK8sEvent(row: K8sEventRow): K8sEvent {
  const kind = EVENT_KINDS[row.reason] ?? "other";
  return {
    id: row.event_uid,
    atMs: Math.round(nsToMs(row.at_offset_ns)),
    pod: row.pod,
    kind,
    severity: toEventSeverity(kind, row),
    label: row.body || row.reason,
  };
}

/**
 * Summary-only trace: everything the list view renders. `spans`/`logs` are
 * empty because list surfaces read `trace_summaries` alone (D7) and never touch
 * the spans table.
 */
export function toTraceSummary(row: TraceSummaryRow): Trace {
  return {
    id: row.trace_id,
    rootName: row.root_name || "(unnamed root)",
    method: row.root_method || "—",
    service: row.root_service,
    startedAt: new Date(Number(row.started_ms)).toISOString(),
    durationMs: nsToMs(row.duration_ns),
    status: Number(row.error_count) > 0 ? "error" : "ok",
    spanCount: Number(row.span_count),
    totalTokens: Number(row.input_tokens) + Number(row.output_tokens),
    costUsd: row.cost_usd,
    services: row.services,
    models: row.models,
    spans: [],
    logs: [],
  };
}

/**
 * D42(d) rail rule (T6): a `LOGS_SQL` row carrying non-empty extracted content
 * (`prompt` and/or `completion`) with an EMPTY `body` is a content carrier —
 * structured GenAI content from the log-record wire form, not a narrative log
 * line. It is excluded from the rail AND its counter (`TraceExplorer.tsx`
 * derives both `solidCount` and `nearbyCount` from `Trace.logs`, so filtering
 * here is the only place that needs to happen — D13/D21: the counter must
 * never claim a row it did not render).
 * It still folds into the matching LLM span's `LlmDetail` via
 * `eventDerivedFillBySpan` above, or folds nowhere if its `span_id` matches no
 * span in this trace (an orphan row — invisible, same as any other row this
 * trace never asked for). A content row that ALSO carries a non-empty `body`
 * renders in the rail as an ordinary log AND still competes for the fold per
 * the precedence above — this filter is only about bodyless carriers. This is
 * a documented display rule, not a silent filter: the row is real, ingested,
 * and counted at the DB (T2's integration test asserts that).
 */
const isContentCarrier = (row: LogRow): boolean => Boolean(row.prompt || row.completion) && !row.body;

/**
 * `logRows` (solid, `trace_id` matched) and `nearbyLogRows` (D37.4, `trace_id`
 * always `''`) both go through `toLogRecord` unchanged — the shape is already
 * what distinguishes them: a real, non-empty `trace_id` maps to `traceId` set,
 * an empty one maps to `traceId: undefined`, which `LogsRail` already renders
 * as NEARBY. No separate nearby adapter is needed. `logRows` is filtered
 * through `isContentCarrier` first (T6, D42(d)) — `nearbyLogRows` never needs
 * that filter, since `NEARBY_LOGS_SQL` never selects `prompt`/`completion`.
 *
 * `nearbyLogRows` arrives UNSLICED from `queryTrace` — up to `NEARBY_LOG_CAP + 1`
 * rows, per NEARBY_LOGS_SQL's `fetch_limit`. This adapter is the one place
 * that both slices to the cap and sets `nearbyLogsTruncated`, from the same
 * length check, so the two facts can never drift apart (advisor ruling: the
 * adapter owns this because it is the only layer that sees the cap+1 fetch).
 * `nearbyLogsTruncated` is set `true` only when truncation is proven and
 * otherwise OMITTED — never `false` — matching the `explanation`/`k8sEvents`
 * optional-field pattern above (D12).
 *
 * `eventRows` (K8S_EVENTS_SQL) defaults to `[]`, and not only for the callers
 * that predate it: `queryTrace` SKIPS that query entirely for a trace whose
 * spans carry no pod, so "no events" is the normal shape for every non-k8s
 * workspace, not an edge case. It maps to an ABSENT `k8sEvents` key rather than
 * an empty array, because `Waterfall.tsx` earns its "pods & k8s events" heading
 * from whether any event exists (`lib/infra-track.ts`) — an empty array would
 * be the same false capability claim that heading was fixed for.
 */
export function toTrace(
  summary: TraceSummaryRow,
  spanRows: SpanRow[],
  logRows: LogRow[],
  nearbyLogRows: LogRow[],
  eventRows: K8sEventRow[] = [],
): Trace {
  const eventFillBySpan = eventDerivedFillBySpan(logRows);
  const spans = spanRows.map((row) => toSpan(row, summary.trace_id, eventFillBySpan));
  const root = spans.find((s) => s.parentId === null);
  const nearbyLogsTruncated = nearbyLogRows.length > NEARBY_LOG_CAP;
  const nearby = nearbyLogRows.slice(0, NEARBY_LOG_CAP);
  const renderedLogs = logRows.filter((row) => !isContentCarrier(row));
  const k8sEvents = eventRows.map(toK8sEvent);
  return {
    ...toTraceSummary(summary),
    rootName: summary.root_name || root?.name || "(unnamed root)",
    service: summary.root_service || root?.service || "",
    spans,
    logs: [...renderedLogs, ...nearby].map((row, i) => toLogRecord(row, i)),
    ...(nearbyLogsTruncated ? { nearbyLogsTruncated: true } : {}),
    ...(k8sEvents.length > 0 ? { k8sEvents } : {}),
  };
}
