/**
 * The frozen SLOs contract (S7.3 packet §0 + D505–D509, D517).
 *
 * CLIENT-SAFE by the `metrics-types.ts` rule (D366) and, like `change-types.ts`,
 * with ZERO imports: the cards, the editor and the store all read this file, and
 * a client component cannot import a `server-only` module for a type alone.
 *
 * This module is half of a cross-language artifact (D517): the indicator schema
 * and the D509 arithmetic exist as a Go implementation too
 * (`services/ingest/internal/alerting/indicator.go`, `slo_math.go`), and the two
 * are frozen against each other by
 * `services/ingest/internal/alerting/testdata/indicator-fixtures.json` — one
 * fixture file, two consumers, identical verdicts AND identical numbers. Change
 * a rule here and the Go side must move with it or the parity tests go red.
 *
 * The EVALUATOR (Go) is the writer of every number a card renders. `sloBudget`
 * below is a MIRROR for the editor's preview; it decides nothing the product
 * shows.
 */

/** D507: rolling windows, in days. Deliberately not the alert lookback (D482). */
export type SloWindow = "7d" | "30d";

/** The window vocabulary as a runtime list, for validation and the editor. */
export const SLO_WINDOWS: readonly SloWindow[] = ["7d", "30d"];

/** The number of days each window covers — what the D507 retention clip note compares against. */
export const SLO_WINDOW_DAYS: Readonly<Record<SloWindow, number>> = { "7d": 7, "30d": 30 };

/** D508/D509: the four statuses. `no-data` is a STATE, never a number. */
export type SloStatus = "healthy" | "at-risk" | "breached" | "no-data";

export const SLO_STATUSES: readonly SloStatus[] = ["healthy", "at-risk", "breached", "no-data"];

/** D505: the two indicator kinds v1 can answer from `trace_summaries`. */
export type SloIndicatorKind = "availability" | "latency";

export const SLO_INDICATOR_KINDS: readonly SloIndicatorKind[] = ["availability", "latency"];

/** A trace is good when it carries no error span. `service: null` = every service (D506). */
export interface AvailabilityIndicator {
  kind: "availability";
  service: string | null;
}

/** A trace is good when its duration (merged max_end − min_start) is ≤ `thresholdMs`. */
export interface LatencyIndicator {
  kind: "latency";
  service: string | null;
  /** A positive whole number of milliseconds. */
  thresholdMs: number;
}

/** The stored shape of `slos.indicator` (JSONB), discriminated on `kind`. */
export type SloIndicator = AvailabilityIndicator | LatencyIndicator;

export type SloIndicatorValidation =
  | { ok: true; indicator: SloIndicator }
  | { ok: false; error: string };

const AVAILABILITY_KEYS = ["kind", "service"] as const;
const LATENCY_KEYS = ["kind", "service", "thresholdMs"] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `keys(value)` must equal `expected` exactly — no unknown key, no missing key. */
function keySetError(value: Record<string, unknown>, expected: readonly string[], kind: string): string | null {
  const allowed = new Set<string>(expected);
  const unknown = Object.keys(value).filter((k) => !allowed.has(k));
  if (unknown.length > 0) {
    return `unknown key${unknown.length > 1 ? "s" : ""} ${unknown.sort().join(", ")} for a${kind === "availability" ? "n" : ""} ${kind} indicator`;
  }
  const missing = expected.filter((k) => !Object.hasOwn(value, k));
  if (missing.length > 0) {
    return `missing key${missing.length > 1 ? "s" : ""} ${missing.join(", ")} for a${kind === "availability" ? "n" : ""} ${kind} indicator`;
  }
  return null;
}

/**
 * D517 (web half): validate on write — an SLO the Go evaluator cannot parse must
 * be unwritable. STRICT: unknown keys rejected, every key of the named kind
 * required, `service` a non-blank string or null (absent is NOT null), and
 * `thresholdMs` a finite positive whole number on latency only. The Go half
 * (`ParseIndicator`) applies the same rules and the shared fixture file proves
 * the two agree case by case.
 */
export function validateSloIndicator(value: unknown): SloIndicatorValidation {
  if (!isPlainObject(value)) return { ok: false, error: "indicator must be a JSON object" };

  const kind = value.kind;
  if (kind !== "availability" && kind !== "latency") {
    return { ok: false, error: `kind must be one of ${SLO_INDICATOR_KINDS.join(", ")}` };
  }

  const keyError = keySetError(value, kind === "availability" ? AVAILABILITY_KEYS : LATENCY_KEYS, kind);
  if (keyError) return { ok: false, error: keyError };

  const service = value.service;
  if (service !== null) {
    if (typeof service !== "string") return { ok: false, error: "service must be a string or null" };
    if (service.trim() === "") return { ok: false, error: "service must not be empty" };
  }

  if (kind === "availability") {
    return { ok: true, indicator: { kind: "availability", service: service as string | null } };
  }

  const thresholdMs = value.thresholdMs;
  if (
    typeof thresholdMs !== "number" ||
    !Number.isFinite(thresholdMs) ||
    thresholdMs <= 0 ||
    !Number.isInteger(thresholdMs) ||
    thresholdMs > 2147483647
  ) {
    return { ok: false, error: "thresholdMs must be a positive whole number of milliseconds" };
  }
  return { ok: true, indicator: { kind: "latency", service: service as string | null, thresholdMs } };
}

// ---- D509: the arithmetic (mirror) -------------------------------------------

/** Where healthy becomes at-risk: the share of the error budget consumed (one constant, the mock's own). */
export const AT_RISK_BUDGET_PCT = 75;

export interface SloBudget {
  /** Attainment, percent — null when no-data. */
  currentPct: number | null;
  /** Error budget consumed, percent, unbounded above — null when no-data. */
  budgetBurnedPct: number | null;
  status: SloStatus;
}

/**
 * The D509 arithmetic, decided on COUNTS in integer arithmetic (exact in a
 * double up to 2^53): a target has at most three decimals, so
 *
 *   breached ⇔ bad × 100000 > total × (100000 − target×1000)
 *
 * with no floating point on the side that decides — 997 of 1000 at a 99.7%
 * target sits exactly on its budget and a float ratio would put it one ulp
 * over. `budgetBurnedPct` is the same ratio ×100, `currentPct` is good/total.
 * Byte-for-byte the Go `sloMeasure`; the fixture's `arithmetic` cases pin both.
 */
export function sloBudget(good: number, total: number, target: number): SloBudget {
  if (!(total > 0)) return { currentPct: null, budgetBurnedPct: null, status: "no-data" };
  const g = Math.min(Math.max(good, 0), total);
  const bad = total - g;
  const allowedMilli = total * (100000 - Math.round(target * 1000));
  const currentPct = (g * 100) / total;
  const budgetBurnedPct = (bad * 100000 * 100) / allowedMilli;
  let status: SloStatus = "healthy";
  if (bad * 100000 > allowedMilli) status = "breached";
  else if (budgetBurnedPct >= AT_RISK_BUDGET_PCT) status = "at-risk";
  return { currentPct, budgetBurnedPct, status };
}

// ---- the ONE objective renderer (packet §0) -------------------------------------

/** A target as its author typed it: `99.9`, `99`, `99.999` — never scientific. */
export function formatSloTarget(target: number): string {
  return String(target);
}

/**
 * The objective sentence is RENDERED from the structure, never stored and never
 * parsed back:
 *
 *   `99.9% of traces without an error span over 30d · service checkout`
 *   `99% of traces under 2000 ms over 7d · all services`
 */
export function formatSloObjective(indicator: SloIndicator, target: number, window: SloWindow): string {
  const scope = indicator.service === null ? "all services" : `service ${indicator.service}`;
  const good = indicator.kind === "availability" ? "without an error span" : `under ${indicator.thresholdMs} ms`;
  return `${formatSloTarget(target)}% of traces ${good} over ${window} · ${scope}`;
}

// ---- packet §0 row shape ------------------------------------------------------------

/** `listSlos(ws)` row. The numbers are the EVALUATOR's (D510); null = never measured / no-data. */
export interface SloRow {
  id: string;
  name: string;
  indicator: SloIndicator;
  /** Percent, at most three decimals. */
  target: number;
  window: SloWindow;
  /** D511: optional — null means computed and rendered, never notified. */
  channelId: string | null;
  channelName: string | null;
  enabled: boolean;
  status: SloStatus;
  currentPct: number | null;
  budgetBurnedPct: number | null;
  goodCount: number | null;
  totalCount: number | null;
  /** ISO UTC, or null when never evaluated. */
  evaluatedAt: string | null;
  /** ISO UTC of the last status change, or null. */
  lastTransitionAt: string | null;
}
