import "server-only";
import type { Layer, LlmDetail, LogRecord, Severity, Span, SpanStatus, Trace } from "@/lib/types";

/**
 * ClickHouse rows → the view-model types in `src/lib/types.ts` (D12). No new UI
 * types: the product's existing shapes are the contract, and anything the
 * pipeline cannot supply yet (`explanation`, `k8sEvents`) stays undefined.
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
  severity_number: number;
  severity_text: string;
  body: string;
  k8s_namespace: string;
  k8s_pod: string;
  k8s_container: string;
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

function toLlmDetail(row: SpanRow, status: SpanStatus): LlmDetail {
  return {
    model: row.gen_ai_response_model || row.gen_ai_request_model,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    costUsd: row.cost_usd,
    prompt: row.prompt,
    completion: row.completion,
    finishReason:
      status === "error" ? "error" : (FINISH_REASONS[row.finish_reason] ?? "stop"),
  };
}

export function toSpan(row: SpanRow, traceId: string): Span {
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
    llm: layer === "llm" ? toLlmDetail(row, status) : undefined,
  };
}

/** OTel severity numbers: 1-4 TRACE, 5-8 DEBUG, 9-12 INFO, 13-16 WARN, 17-20 ERROR, 21+ FATAL. */
function toSeverity(row: LogRow): Severity {
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
 * `logRows` (solid, `trace_id` matched) and `nearbyLogRows` (D37.4, `trace_id`
 * always `''`) both go through `toLogRecord` unchanged — the shape is already
 * what distinguishes them: a real, non-empty `trace_id` maps to `traceId` set,
 * an empty one maps to `traceId: undefined`, which `LogsRail` already renders
 * as NEARBY. No separate nearby adapter is needed.
 */
export function toTrace(
  summary: TraceSummaryRow,
  spanRows: SpanRow[],
  logRows: LogRow[],
  nearbyLogRows: LogRow[],
): Trace {
  const spans = spanRows.map((row) => toSpan(row, summary.trace_id));
  const root = spans.find((s) => s.parentId === null);
  return {
    ...toTraceSummary(summary),
    rootName: summary.root_name || root?.name || "(unnamed root)",
    service: summary.root_service || root?.service || "",
    spans,
    logs: [...logRows, ...nearbyLogRows].map((row, i) => toLogRecord(row, i)),
  };
}
