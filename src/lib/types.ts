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

/** A Kubernetes-level event rendered on the trace's infra track. */
export interface K8sEvent {
  id: string;
  atMs: number;
  pod: string;
  kind: "oom_kill" | "restart" | "scale" | "reindex" | "throttle";
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
  evidence: { label: string; detail: string }[];
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
}
