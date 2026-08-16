/**
 * The logs explorer's URL contract: the parameter names, how a URL becomes the
 * facade's `LogFilter`, and how the filter bar serializes itself back.
 *
 * The URL is the single source of filter state for `/app/logs` — a deep link
 * reproduces a view exactly — so the server page (which parses) and the client
 * bar (which serializes) must agree on every parameter name and every default.
 * That agreement is a K1 one-definition problem, and a server component cannot
 * call functions exported from a `"use client"` module (they become client
 * references), so the contract lives here: a pure, client-safe module both
 * sides import, next to `live-routes.ts` and `saved-views.ts` on the same
 * precedent. `traces-filter.ts` is the ratified shape this mirrors (D65).
 *
 * There is no page parameter: `/app/logs` is a capped window, not a paginated
 * list (D44's sub-ruling), so nothing here has a page key to strip.
 *
 * Filter SEMANTICS are the query layer's (`server/queries/logs.ts`, and the
 * term rules in `server/search-contract.md`): everything here is naming,
 * parsing and serialization. The severity ORDER lives here because it is one
 * list doing two jobs — the URL's vocabulary and the rank the SQL indexes into
 * — and two copies of it is exactly the drift this module exists to prevent.
 */

import type { SavedViewFilters } from "@/lib/saved-views";
import type { Severity } from "@/lib/types";
import type { LogFilter } from "@/server/data";

/** The surface these parameters belong to; every link and navigation goes here. */
export const LOGS_PATH = "/app/logs";

/**
 * The time ranges the bar offers, in hours back from the reference clock (D50 —
 * the clock is per mode and belongs to the facade, not to this module).
 */
export const LOG_RANGE_HOURS = { "1h": 1, "6h": 6, "24h": 24 } as const;

export type LogRange = keyof typeof LOG_RANGE_HOURS;

/**
 * The one product-wide default (D50), stated here as a label because the header
 * displays the APPLIED bound. `logs-filter.test.ts` pins it to the facade's
 * `DEFAULT_TRACE_RANGE_MS` so the label and the query can never mean different
 * windows, and so the two surfaces cannot drift into separate "6h"s.
 */
export const DEFAULT_LOG_RANGE: LogRange = "6h";

export function logRangeMs(range: LogRange): number {
  return LOG_RANGE_HOURS[range] * 3_600_000;
}

/**
 * The severity floor vocabulary, weakest first — the index in this array IS the
 * rank `queries/logs.ts` computes in SQL, so the URL value, the filter and the
 * rendered label are one ordering with one definition.
 */
export const SEVERITY_ORDER: readonly Severity[] = ["debug", "info", "warn", "error", "fatal"];

/** The weakest floor: "severity: all". Absent or unrecognised `sev` means this. */
export const DEFAULT_LOG_SEVERITY: Severity = SEVERITY_ORDER[0];

/** The `/app/logs` filter set as the bar holds it: every value normalized, nothing optional. */
export interface LogsFilters {
  q: string;
  sev: Severity;
  pod: string;
  onTrace: boolean;
  range: LogRange;
}

/** What a filter is when the URL says nothing about it. */
export const EMPTY_LOGS_FILTERS: LogsFilters = {
  q: "",
  sev: DEFAULT_LOG_SEVERITY,
  pod: "",
  onTrace: false,
  range: DEFAULT_LOG_RANGE,
};

type UrlParam = string | string[] | undefined;

function one(value: UrlParam): string {
  return ((Array.isArray(value) ? value[0] : value) ?? "").trim();
}

/**
 * A URL's parameters as the bar's filter set. Every unparseable or absent value
 * falls back to `EMPTY_LOGS_FILTERS`, so a hand-typed link can be wrong but
 * never renders a broken bar — and never reaches the query layer as a broken
 * bound.
 *
 * `Object.hasOwn`, never `range in LOG_RANGE_HOURS`: `in` walks the prototype
 * chain, so `?range=toString` resolved to `Function.prototype.toString`, made
 * the window `NaN` and 500'd the route in live mode (silently emptied it in
 * mock) instead of falling back to the default. Same reason severity is checked
 * against the array's contents rather than a lookup.
 */
export function parseLogsUrl(params: Record<string, UrlParam>): LogsFilters {
  const sev = one(params.sev);
  const range = one(params.range);
  return {
    q: one(params.q),
    sev: SEVERITY_ORDER.includes(sev as Severity) ? (sev as Severity) : DEFAULT_LOG_SEVERITY,
    pod: one(params.pod),
    onTrace: one(params.onTrace) === "1",
    range: Object.hasOwn(LOG_RANGE_HOURS, range) ? (range as LogRange) : DEFAULT_LOG_RANGE,
  };
}

/**
 * The canonical query string for a filter set: defaults are omitted, so the
 * unfiltered window is a bare `/app/logs` and two equal filter sets always
 * serialize to the same string (the bar compares these strings to tell its own
 * navigation apart from one that happened underneath it).
 */
export function logsSearchString(filters: LogsFilters): string {
  const p = new URLSearchParams();
  if (filters.q) p.set("q", filters.q);
  if (filters.sev !== DEFAULT_LOG_SEVERITY) p.set("sev", filters.sev);
  if (filters.pod) p.set("pod", filters.pod);
  if (filters.onTrace) p.set("onTrace", "1");
  if (filters.range !== DEFAULT_LOG_RANGE) p.set("range", filters.range);
  return p.toString();
}

/** The href a query string addresses. */
export function logsHref(search: string): string {
  return search ? `${LOGS_PATH}?${search}` : LOGS_PATH;
}

/**
 * What the facade is asked for a given URL. This is the whole server-side
 * mapping: nothing is re-filtered client-side (D13), so a control that does not
 * arrive here does not filter anything.
 */
export function toLogFilter(filters: LogsFilters): LogFilter {
  return {
    q: filters.q,
    minSeverity: filters.sev,
    pod: filters.pod,
    onTraceOnly: filters.onTrace,
    rangeMs: logRangeMs(filters.range),
  };
}

/**
 * The filter set as `SavedViewsMenu` takes it (D47(v)): the surface's URL
 * parameters, one string value per key. A view is the whole set, so applying
 * one REPLACES the bar's state — a key the view does not carry is a filter the
 * view leaves at its default (D47(ii)).
 */
export function logsViewFilters(filters: LogsFilters): SavedViewFilters {
  return Object.fromEntries(new URLSearchParams(logsSearchString(filters)));
}
