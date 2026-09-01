/**
 * The frozen alerts contract (S7.1 packet §0 + D481/D482/D483).
 *
 * CLIENT-SAFE by the `metrics-types.ts` rule (D366): the rules list, the events
 * feed and the rule editor are client components, and a client component cannot
 * import a `server-only` module for a type alone (S1.5/D10). The ONE runtime
 * import here is `./metrics-types`, which is itself client-safe and holds the
 * agg-validity table — D390 says that table has exactly one definition, so a
 * metric alert condition reuses `VALID_AGGS` rather than restating it.
 *
 * This module is also half of a cross-language artifact (D483): the same schema
 * exists as a Go struct in `services/ingest/internal/alerting/condition.go`, and
 * the two are frozen against each other by
 * `services/ingest/internal/alerting/testdata/condition-fixtures.json` — one
 * fixture file, two consumers, identical verdicts. Change a rule here and the
 * Go side must move with it or the parity tests go red.
 */
import { VALID_AGGS, type MetricAgg, type MetricCatalogEntry } from "./metrics-types";

/**
 * D482: the alert lookback vocabulary is NEW and deliberately not `MetricRange`.
 * `MetricRange` (1h/6h/24h) is a CHART WIDTH — how much history a graph draws.
 * This is an ALERT LOOKBACK — how much history one evaluation aggregates over.
 * The two answer different questions and will drift (a 5m lookback is a useless
 * chart width; a 24h lookback is a useless pager), so overloading `MetricRange`
 * would couple two vocabularies that have no reason to stay equal. Its
 * "extensible at M6" hook is exercised by NOT being extended here.
 *
 * Every window is ≤ 1h, which is what lets evaluation read the raw/1m tier by
 * construction — no rollup-grain choice is implied by this list.
 */
export type AlertWindow = "5m" | "15m" | "30m" | "1h";

/** The window vocabulary as a runtime list, for validation and the editor's options. */
export const ALERT_WINDOWS: readonly AlertWindow[] = ["5m", "15m", "30m", "1h"];

/** Threshold comparison. Two operators only — `>=`/`<=` add no alerting power over a float threshold. */
export type AlertOp = ">" | "<";

/** The operator vocabulary as a runtime list. */
export const ALERT_OPS: readonly AlertOp[] = [">", "<"];

/** The metric type vocabulary, derived from the ONE agg-validity table (D390) — never restated. */
export const METRIC_TYPES = Object.keys(VALID_AGGS) as readonly MetricCatalogEntry["type"][];

/** D481: the two trace-side signals. Both are computed over `trace_summaries`. */
export type TraceSignal = "error_rate_pct" | "p95_ms";

/** The trace-signal vocabulary as a runtime list. */
export const TRACE_SIGNALS: readonly TraceSignal[] = ["error_rate_pct", "p95_ms"];

/**
 * D481: an alert over the metrics leg. The vocabulary IS the D363 contract —
 * `type` + `agg` validity is `VALID_AGGS` verbatim, `filters` is the
 * observed-attribute-key shape `MetricSeriesQuery.filters` already uses.
 * Evaluation = the aggregate over `window`, compared to `threshold` with `op`.
 */
export interface MetricAlertCondition {
  source: "metric";
  /** OTLP metric name = the identity; non-empty. */
  metric: string;
  /** REQUIRED and named by the caller, never inferred — the D384 reason. */
  type: MetricCatalogEntry["type"];
  /** Must be in `VALID_AGGS[type]` (D390). */
  agg: MetricAgg;
  window: AlertWindow;
  op: AlertOp;
  threshold: number;
  /** attrKey -> exact value; `{}` means "the metric as a whole". */
  filters: Record<string, string>;
}

/**
 * D481: an alert over the traces leg, covering the mock's headline rules
 * (error rate, p95) honestly. `service: null` = every service in the workspace.
 */
export interface TraceAlertCondition {
  source: "trace";
  signal: TraceSignal;
  /** A `service.name` value, or null for all services; non-empty when set. */
  service: string | null;
  window: AlertWindow;
  op: AlertOp;
  threshold: number;
}

/** The stored shape of `alert_rules.condition` (JSONB), discriminated on `source`. */
export type AlertCondition = MetricAlertCondition | TraceAlertCondition;

/** What `validateAlertCondition` answers: the narrowed condition, or the reason it is unwritable. */
export type AlertConditionValidation =
  | { ok: true; condition: AlertCondition }
  | { ok: false; error: string };

/** The exact key set of each variant — the "unknown keys rejected" half of strictness. */
const METRIC_KEYS = ["source", "metric", "type", "agg", "window", "op", "threshold", "filters"] as const;
const TRACE_KEYS = ["source", "signal", "service", "window", "op", "threshold"] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `keys(value)` must equal `expected` exactly — no unknown key, no missing key. */
function keySetError(value: Record<string, unknown>, expected: readonly string[]): string | null {
  const allowed = new Set<string>(expected);
  const unknown = Object.keys(value).filter((k) => !allowed.has(k));
  if (unknown.length > 0) return `unknown key${unknown.length > 1 ? "s" : ""} ${unknown.sort().join(", ")}`;
  const missing = expected.filter((k) => !Object.hasOwn(value, k));
  if (missing.length > 0) return `missing key${missing.length > 1 ? "s" : ""} ${missing.join(", ")}`;
  return null;
}

function nonEmpty(value: unknown, field: string): string | null {
  if (typeof value !== "string") return `${field} must be a string`;
  if (value.trim() === "") return `${field} must not be empty`;
  return null;
}

/**
 * D483 (web half): validate on write — a rule the Go evaluator cannot parse must
 * be unwritable. STRICT on purpose: unknown keys rejected, every key required,
 * `threshold` a finite number (JSON `1e999` parses to Infinity, which is not a
 * threshold), names non-empty, filter values strings. The Go half
 * (`ParseCondition`) applies the same rules and the shared fixture file proves
 * the two agree case by case.
 */
export function validateAlertCondition(value: unknown): AlertConditionValidation {
  if (!isPlainObject(value)) return { ok: false, error: "condition must be a JSON object" };

  const source = value.source;
  if (source !== "metric" && source !== "trace") {
    return { ok: false, error: `source must be "metric" or "trace"` };
  }

  const keyError = keySetError(value, source === "metric" ? METRIC_KEYS : TRACE_KEYS);
  if (keyError) return { ok: false, error: `${keyError} for a ${source} condition` };

  // Shared across both variants.
  const window = value.window;
  if (!ALERT_WINDOWS.includes(window as AlertWindow)) {
    return { ok: false, error: `window must be one of ${ALERT_WINDOWS.join(", ")}` };
  }
  const op = value.op;
  if (!ALERT_OPS.includes(op as AlertOp)) {
    return { ok: false, error: `op must be one of ${ALERT_OPS.join(", ")}` };
  }
  const threshold = value.threshold;
  if (typeof threshold !== "number" || !Number.isFinite(threshold)) {
    return { ok: false, error: "threshold must be a finite number" };
  }

  if (source === "trace") {
    const signal = value.signal;
    if (!TRACE_SIGNALS.includes(signal as TraceSignal)) {
      return { ok: false, error: `signal must be one of ${TRACE_SIGNALS.join(", ")}` };
    }
    const service = value.service;
    if (service !== null) {
      const err = nonEmpty(service, "service");
      if (err) return { ok: false, error: err };
    }
    return {
      ok: true,
      condition: {
        source: "trace",
        signal: signal as TraceSignal,
        service: service as string | null,
        window: window as AlertWindow,
        op: op as AlertOp,
        threshold,
      },
    };
  }

  const metricError = nonEmpty(value.metric, "metric");
  if (metricError) return { ok: false, error: metricError };
  const type = value.type;
  if (!METRIC_TYPES.includes(type as MetricCatalogEntry["type"])) {
    return { ok: false, error: `type must be one of ${METRIC_TYPES.join(", ")}` };
  }
  const validAggs = VALID_AGGS[type as MetricCatalogEntry["type"]];
  const agg = value.agg;
  if (typeof agg !== "string" || !validAggs.includes(agg as MetricAgg)) {
    return { ok: false, error: `agg must be one of ${validAggs.join(", ")} for a ${String(type)} metric` };
  }
  const filters = value.filters;
  if (!isPlainObject(filters)) return { ok: false, error: "filters must be an object" };
  for (const [key, filterValue] of Object.entries(filters)) {
    if (typeof filterValue !== "string") return { ok: false, error: `filter ${key} must be a string value` };
  }

  return {
    ok: true,
    condition: {
      source: "metric",
      metric: value.metric as string,
      type: type as MetricCatalogEntry["type"],
      agg: agg as MetricAgg,
      window: window as AlertWindow,
      op: op as AlertOp,
      threshold,
      filters: filters as Record<string, string>,
    },
  };
}

/**
 * The ONE condition→string renderer (packet §0): the human-readable condition is
 * RENDERED from the structured condition, never stored and never parsed back.
 * Because nothing reads it, the format is free to change; because it is the only
 * renderer, the rules list and the event title can never disagree about what a
 * rule says.
 *
 *   `sum(rate) http.requests > 100 over 5m · env=prod`
 *   `error_rate_pct > 5 over 15m · service checkout`
 *
 * Filters render sorted by key so the same condition always renders the same
 * string regardless of JSON key order.
 */
export function formatAlertCondition(c: AlertCondition): string {
  if (c.source === "trace") {
    const scope = c.service === null ? "all services" : `service ${c.service}`;
    return `${c.signal} ${c.op} ${c.threshold} over ${c.window} · ${scope}`;
  }
  const head = `${c.type}(${c.agg}) ${c.metric} ${c.op} ${c.threshold} over ${c.window}`;
  const filters = Object.keys(c.filters)
    .sort()
    .map((k) => `${k}=${c.filters[k]}`);
  return filters.length === 0 ? head : `${head} · ${filters.join(" ")}`;
}

// ---- packet §0 row shapes ---------------------------------------------------

/** D484: severity is the RULE author's choice — how loud this rule is — not a per-event guess. */
export type AlertSeverity = "critical" | "warning" | "info";

/** D484: the whole per-rule state machine. Transitions are the only event producers. */
export type AlertRuleState = "ok" | "firing";

/** D485/D490: the delivery truth of one event, rendered honestly in the feed (D13). */
export type AlertDelivery = "pending" | "delivered" | "failed";

/** D486: the two v1 channel kinds. Both are one HTTPS POST; the kind shapes the payload. */
export type NotificationChannelKind = "webhook" | "slack_webhook";

/** `listAlertRules(ws)` row. `condition` is structured; the string is rendered by `formatAlertCondition`. */
export interface AlertRuleRow {
  id: string;
  name: string;
  condition: AlertCondition;
  severity: AlertSeverity;
  channelId: string;
  channelName: string;
  enabled: boolean;
  /** A free-text URL, or null — rendered as a link when present (packet §0). */
  runbook: string | null;
  state: AlertRuleState;
  /** ISO UTC, or null when the rule has never fired. */
  lastTriggeredAt: string | null;
}

/** `listAlertEvents(ws, limit)` row, newest-first. */
export interface AlertEventRow {
  id: string;
  /** D491: nullable — a `sendTestNotification` event belongs to no rule. */
  ruleId: string | null;
  /** The rule's name at read time, or null for a rule-less (test) event. */
  ruleName: string | null;
  severity: AlertSeverity;
  title: string;
  detail: string;
  /** Deep link into the product, or null. */
  link: string | null;
  delivery: AlertDelivery;
  /** ISO UTC. */
  at: string;
}

/** `listNotificationChannels(ws)` row. The target is ALWAYS masked on read (D487). */
export interface NotificationChannelRow {
  id: string;
  name: string;
  kind: NotificationChannelKind;
  /** scheme+host+last-4 — never the whole target, on any read path (D487). */
  targetMasked: string;
  enabled: boolean;
}
