/**
 * The traces list's URL contract: the parameter names, how a URL becomes the
 * facade's `TraceFilter`, and how the filter bar serializes itself back.
 *
 * The URL is the single source of filter state for `/app/traces` — a deep link
 * reproduces a view exactly — so the server page (which parses) and the client
 * bar (which serializes) must agree on every parameter name. That agreement is
 * a K1 one-definition problem, and a server component cannot call functions
 * exported from a `"use client"` module (they become client references), so the
 * contract lives here: a pure, client-safe module both sides import, next to
 * `live-routes.ts` and `saved-views.ts` on the same precedent.
 *
 * The page parameter is NOT defined here: it is `PAGE_PARAM`, imported from
 * `@/lib/saved-views`, because that module strips the page key when it persists
 * a view (D47(ii)/D53) and the literal is load-bearing where the delete happens.
 *
 * Filter SEMANTICS are the search contract's (`server/search-contract.md`), not
 * this module's: everything here is naming, parsing and serialization.
 */

import { PAGE_PARAM, type SavedViewFilters } from "@/lib/saved-views";
import type { TraceFilter } from "@/server/data";

/** The surface these parameters belong to; the pager and the bar both link here. */
export const TRACES_PATH = "/app/traces";

/**
 * The time ranges the bar offers, in hours back from the reference clock (D50 —
 * the clock is per mode and belongs to the facade, not to this module).
 */
export const TRACE_RANGE_HOURS = { "1h": 1, "6h": 6, "24h": 24 } as const;

export type TraceRange = keyof typeof TRACE_RANGE_HOURS;

/**
 * The one product-wide default (D50), stated here as a label because the header
 * displays the APPLIED bound. `traces-filter.test.ts` pins it to the facade's
 * `DEFAULT_TRACE_RANGE_MS` so the label and the query can never mean different
 * windows.
 */
export const DEFAULT_TRACE_RANGE: TraceRange = "6h";

export function traceRangeMs(range: TraceRange): number {
  return TRACE_RANGE_HOURS[range] * 3_600_000;
}

/**
 * The status values the URL takes — and the ones the bar's select offers, which
 * renders this list rather than restating it: an option whose value the parse
 * does not recognise is a control that silently filters nothing (K1, the same
 * rule that makes the range select read `TRACE_RANGE_HOURS`).
 */
export const TRACE_STATUSES = ["all", "ok", "error"] as const;

type Status = (typeof TRACE_STATUSES)[number];

/**
 * The PRD §8 filter set as the bar holds it: every value normalized, nothing
 * optional. `maxCost` is `-1` when unbounded, matching `TraceFilter`'s rule
 * ("absent or negative = unbounded"); `page` is 1-based.
 */
export interface TracesFilters {
  q: string;
  status: Status;
  service: string;
  model: string;
  minMs: number;
  minCost: number;
  maxCost: number;
  range: TraceRange;
  page: number;
}

/** What a filter is when the URL says nothing about it. */
export const EMPTY_TRACES_FILTERS: TracesFilters = {
  q: "",
  status: "all",
  service: "",
  model: "",
  minMs: 0,
  minCost: 0,
  maxCost: -1,
  range: DEFAULT_TRACE_RANGE,
  page: 1,
};

type UrlParam = string | string[] | undefined;

function one(value: UrlParam): string {
  return ((Array.isArray(value) ? value[0] : value) ?? "").trim();
}

function positive(value: UrlParam): number {
  const n = Number(one(value));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** A cost ceiling, or -1 for unbounded — `TraceFilter`'s own convention. */
function ceiling(value: UrlParam): number {
  const raw = one(value);
  const n = Number(raw);
  return raw !== "" && Number.isFinite(n) && n >= 0 ? n : -1;
}

/**
 * A URL's parameters as the bar's filter set. Every unparseable or absent value
 * falls back to `EMPTY_TRACES_FILTERS`, so a hand-typed link can be wrong but
 * never renders a broken bar.
 */
export function parseTracesUrl(params: Record<string, UrlParam>): TracesFilters {
  const status = one(params.status);
  const range = one(params.range);
  const page = Math.floor(Number(one(params[PAGE_PARAM])));
  return {
    q: one(params.q),
    status: TRACE_STATUSES.includes(status as Status) ? (status as Status) : "all",
    service: one(params.service),
    model: one(params.model),
    minMs: positive(params.minMs),
    minCost: positive(params.minCost),
    maxCost: ceiling(params.maxCost),
    // `Object.hasOwn`, never `in`: `in` walks the prototype chain, so
    // `?range=toString` would name `Function.prototype.toString` a range and
    // hand the query `NaN` milliseconds (D66). Same guard, same reason, as the
    // logs surface's range parse — the canonical one, cross-cited here so the
    // two surfaces cannot diverge on what a valid range name is.
    range: Object.hasOwn(TRACE_RANGE_HOURS, range) ? (range as TraceRange) : DEFAULT_TRACE_RANGE,
    // A SAFE integer, not merely a finite one (D66's class): the page becomes a
    // query offset, and past 2^53 JavaScript prints large numbers in
    // exponential notation — `1e21` reached the query as the literal "2e+23",
    // which ClickHouse cannot parse, and the surface answered 500.
    page: Number.isSafeInteger(page) && page >= 1 ? page : 1,
  };
}

/**
 * The canonical query string for a filter set: defaults are omitted, so the
 * unfiltered list is a bare `/app/traces` and two equal filter sets always
 * serialize to the same string (the bar compares these strings to tell its own
 * navigation apart from one that happened underneath it).
 */
export function tracesSearchString(filters: TracesFilters): string {
  const p = new URLSearchParams();
  if (filters.q) p.set("q", filters.q);
  if (filters.status !== "all") p.set("status", filters.status);
  if (filters.service) p.set("service", filters.service);
  if (filters.model) p.set("model", filters.model);
  if (filters.minMs > 0) p.set("minMs", String(filters.minMs));
  if (filters.minCost > 0) p.set("minCost", String(filters.minCost));
  if (filters.maxCost >= 0) p.set("maxCost", String(filters.maxCost));
  if (filters.range !== DEFAULT_TRACE_RANGE) p.set("range", filters.range);
  if (filters.page > 1) p.set(PAGE_PARAM, String(filters.page));
  return p.toString();
}

/** The href a query string addresses — every link and navigation in the bar. */
export function tracesHref(search: string): string {
  return search ? `${TRACES_PATH}?${search}` : TRACES_PATH;
}

/**
 * What the facade is asked for a given URL. This is the whole server-side
 * mapping: nothing is re-filtered client-side (D13), so a control that does not
 * arrive here does not filter anything.
 */
export function toTraceFilter(filters: TracesFilters): TraceFilter {
  return {
    q: filters.q,
    status: filters.status,
    service: filters.service,
    model: filters.model,
    minMs: filters.minMs,
    minCostUsd: filters.minCost,
    maxCostUsd: filters.maxCost,
    rangeMs: traceRangeMs(filters.range),
    page: filters.page,
  };
}

/**
 * The filter set as `SavedViewsMenu` takes it (D47(v)): the surface's URL
 * parameters, one string value per key. The page key rides along when the user
 * is past page 1 and `saveView` drops it by `PAGE_PARAM` — a view is a
 * question, not a position in a result set (D47(ii)).
 */
export function tracesViewFilters(filters: TracesFilters): SavedViewFilters {
  return Object.fromEntries(new URLSearchParams(tracesSearchString(filters)));
}

/**
 * What the bar remembers about the URL so it can tell its own navigation from
 * one that happened underneath it (carry-forward 2).
 */
export interface UrlSync {
  /** the query string the bar last received from the server */
  seen: string;
  /** query strings the bar navigated to whose server render has not come back yet */
  pending: readonly string[];
}

/** Bookkeeping for a navigation the bar itself just started. */
export function pushedUrl(sync: UrlSync, search: string): UrlSync {
  return { seen: sync.seen, pending: [...sync.pending, search] };
}

/**
 * Carry-forward 2, the whole rule in one place: what to do with the query
 * string the server just rendered.
 *
 * A URL the bar did not produce — back/forward, a link into a filtered view, a
 * saved view applied elsewhere — is ADOPTED: the inputs take its values, or
 * they keep their mount-time values forever, which is the bug this replaces.
 * The bar's own navigation coming back is not, because the user usually types
 * on while it is in flight and adopting it would rewind their text; the echo is
 * consumed from `pending` so the same URL reached again later is external.
 * Adopting clears `pending` outright: the bar has been moved somewhere else, so
 * an echo still in flight for the URL it left is no longer about its state.
 */
export function syncUrl(sync: UrlSync, incoming: string): { adopt: boolean; sync: UrlSync } {
  if (incoming === sync.seen) return { adopt: false, sync };
  const echo = sync.pending.indexOf(incoming);
  if (echo >= 0) {
    return {
      adopt: false,
      sync: { seen: incoming, pending: sync.pending.filter((_, i) => i !== echo) },
    };
  }
  return { adopt: true, sync: { seen: incoming, pending: [] } };
}
