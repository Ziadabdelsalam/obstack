/** "other" is the ingest-side catch-all for spans no D8 rule classifies. */
export type Layer = "api" | "agent" | "tool" | "llm" | "infra" | "other";

export type SpanStatus = "ok" | "error";

export interface LlmDetail {
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  prompt: string;
  completion: string;
  finishReason: "stop" | "length" | "truncated" | "error";
}

export interface Span {
  id: string;
  traceId: string;
  parentId: string | null;
  name: string;
  layer: Layer;
  service: string;
  /** k8s pod that executed this span (resource attribution) */
  pod?: string;
  /** k8s node the pod was scheduled on */
  node?: string;
  /** offset from trace start */
  startMs: number;
  durationMs: number;
  status: SpanStatus;
  statusMessage?: string;
  attrs: Record<string, string | number>;
  llm?: LlmDetail;
}

/**
 * A Kubernetes-level event rendered on the trace's infra track.
 *
 * `kind` is a curated union, not the open-ended set of k8s event reasons: the
 * live adapter (`server/adapters.ts`) maps the reasons the product has a story
 * for onto the named members and everything else onto `"other"`, so a new
 * upstream reason renders as a plain marker instead of being dropped. The UI
 * renders the kind as text and colors by `severity`, so the catch-all needs no
 * per-kind styling.
 */
export interface K8sEvent {
  id: string;
  atMs: number;
  pod: string;
  kind: "oom_kill" | "restart" | "scale" | "reindex" | "throttle" | "other";
  severity: "info" | "warn" | "fatal";
  label: string;
}

export type Severity = "debug" | "info" | "warn" | "error" | "fatal";

export interface LogRecord {
  id: string;
  /** present = solid trace_id match; absent = "nearby" time-window match */
  traceId?: string;
  /** offset from trace start (can be negative for nearby-before) */
  atMs: number;
  severity: Severity;
  body: string;
  namespace: string;
  pod: string;
  container: string;
}

export interface Explanation {
  headline: string;
  failedWhere: string;
  rootCause: string;
  /**
   * One cited fact. The four reference keys are the subject's OWN ids (D223,
   * D553): `spanId`/`logRef` are a `Span.id` and a `LogRecord.id` when the
   * subject is a trace; `eventRef`/`traceRef` are an alert or change event id
   * (`evt_`/`chg_`) and a trace id when the subject is an incident. They are
   * what makes evidence a link rather than a sentence. EXACTLY ONE of the four
   * is ever set on an item, and none is set on an item that earned no link:
   * a live explanation whose model-supplied id is not in the subject has it
   * dropped and the drop stated in `detail` (`server/explain/validate.ts`), so
   * the renderer has to handle an unlinked item anyway. Mock and live render
   * through the one renderer — there is no mode fork here.
   */
  evidence: {
    label: string;
    detail: string;
    spanId?: string;
    logRef?: string;
    eventRef?: string;
    traceRef?: string;
  }[];
  suggestion: string;
}

export interface Trace {
  id: string;
  rootName: string;
  method: string;
  service: string;
  startedAt: string; // ISO
  durationMs: number;
  status: SpanStatus;
  spanCount: number;
  totalTokens: number;
  costUsd: number;
  services: string[];
  models: string[];
  spans: Span[];
  logs: LogRecord[];
  k8sEvents?: K8sEvent[];
  explanation?: Explanation;
  /** true only when the nearby-logs query is known to have more rows than the cap (D13/D21); omitted — never false — otherwise. Mock mode never sets it. */
  nearbyLogsTruncated?: boolean;
}
