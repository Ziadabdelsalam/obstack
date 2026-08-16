import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DEFAULT_TRACE_RANGE_MS } from "@/server/queries/traces";
import {
  DEFAULT_LOG_RANGE,
  DEFAULT_LOG_SEVERITY,
  EMPTY_LOGS_FILTERS,
  LOG_RANGE_HOURS,
  SEVERITY_ORDER,
  logRangeMs,
  logsHref,
  logsSearchString,
  logsViewFilters,
  parseLogsUrl,
  toLogFilter,
  type LogsFilters,
} from "./logs-filter";

// run with: npm test --workspace apps/web
//
// D65: the `/app/logs` URL contract lives in ONE client-safe module that the
// server page (which parses) and the filter bar (which serializes) both import.
// The assertions below deliberately spell out the DEFAULT VALUES as literals
// rather than referencing the constants: that is what makes them a probe — move
// a default at its single site and both the page-side (`parseLogsUrl`) and the
// bar-side (`logsSearchString`) assertions go red together, which is the whole
// property the extraction exists to hold.

test("D65: an absent parameter parses to the surface's default — the page's half", () => {
  const parsed = parseLogsUrl({});
  assert.equal(parsed.range, "6h", "the default time window moved; the bar's half below moves with it");
  assert.equal(parsed.sev, "debug", "the default severity floor moved; the bar's half below moves with it");
  assert.deepEqual(parsed, EMPTY_LOGS_FILTERS);
});

test("D65: the bar omits exactly the defaults it parses back — the bar's half", () => {
  assert.equal(logsSearchString(EMPTY_LOGS_FILTERS), "");
  assert.equal(logsSearchString({ ...EMPTY_LOGS_FILTERS, range: "6h" }), "");
  assert.equal(logsSearchString({ ...EMPTY_LOGS_FILTERS, sev: "debug" }), "");
  // ...and serializes everything that is not a default
  assert.equal(logsSearchString({ ...EMPTY_LOGS_FILTERS, range: "1h" }), "range=1h");
  assert.equal(logsSearchString({ ...EMPTY_LOGS_FILTERS, sev: "error" }), "sev=error");
  assert.equal(
    logsSearchString({ q: "pool exhausted", sev: "warn", pod: "gateway-1", onTrace: true, range: "24h" }),
    "q=pool+exhausted&sev=warn&pod=gateway-1&onTrace=1&range=24h",
  );
});

test("D65: every filter round-trips URL → filters → URL unchanged", () => {
  const cases: LogsFilters[] = [
    EMPTY_LOGS_FILTERS,
    { ...EMPTY_LOGS_FILTERS, q: "cache miss" },
    { ...EMPTY_LOGS_FILTERS, sev: "fatal" },
    { ...EMPTY_LOGS_FILTERS, pod: "postgres-0" },
    { ...EMPTY_LOGS_FILTERS, onTrace: true },
    { ...EMPTY_LOGS_FILTERS, range: "24h" },
    { q: "a b", sev: "error", pod: "p", onTrace: true, range: "1h" },
  ];
  for (const filters of cases) {
    const search = logsSearchString(filters);
    const params = Object.fromEntries(new URLSearchParams(search));
    assert.deepEqual(parseLogsUrl(params), filters, `round trip of ${JSON.stringify(search)}`);
    assert.equal(logsHref(search), search ? `/app/logs?${search}` : "/app/logs");
  }
});

// The reviewer's 500: `range in LOG_RANGE_HOURS` walks the prototype chain, so
// `?range=toString` resolved to a Function, made the window NaN and 500'd the
// route in live mode. Restore `in` and every key below goes red.
test("D65: a prototype key is not a range (Object.hasOwn, never `in`)", () => {
  for (const hostile of ["toString", "constructor", "valueOf", "hasOwnProperty", "__proto__", "nope"]) {
    const parsed = parseLogsUrl({ range: hostile, sev: hostile });
    assert.equal(parsed.range, DEFAULT_LOG_RANGE, `?range=${hostile} did not fall back to the default`);
    assert.equal(parsed.sev, DEFAULT_LOG_SEVERITY, `?sev=${hostile} did not fall back to the default`);
    assert.ok(Number.isFinite(logRangeMs(parsed.range)), `?range=${hostile} produced a non-finite window`);
  }
});

test("D65: a repeated or padded parameter still parses to one trimmed value", () => {
  assert.equal(parseLogsUrl({ q: ["first", "second"] }).q, "first");
  assert.equal(parseLogsUrl({ pod: "  postgres-0  " }).pod, "postgres-0");
  assert.equal(parseLogsUrl({ onTrace: "true" }).onTrace, false, "only the canonical '1' turns the toggle on");
  assert.equal(parseLogsUrl({ onTrace: "1" }).onTrace, true);
});

test("D50: the logs default window is the SAME product-wide 6h the traces list uses", () => {
  assert.equal(
    logRangeMs(DEFAULT_LOG_RANGE),
    DEFAULT_TRACE_RANGE_MS,
    "the two surfaces drifted into different 6h defaults while both headers claim one bound",
  );
});

test("D65: what the facade is asked is exactly what the URL said", () => {
  assert.deepEqual(toLogFilter({ q: "x", sev: "warn", pod: "p", onTrace: true, range: "24h" }), {
    q: "x",
    minSeverity: "warn",
    pod: "p",
    onTraceOnly: true,
    rangeMs: 24 * 3_600_000,
  });
  // A saved view is the same string as a URL — one shape, not two (D47(ii)).
  assert.deepEqual(logsViewFilters({ ...EMPTY_LOGS_FILTERS, sev: "error", onTrace: true }), {
    sev: "error",
    onTrace: "1",
  });
  assert.deepEqual(logsViewFilters(EMPTY_LOGS_FILTERS), {});
});

// ---- D65's single-module sweep ---------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_SRC = path.resolve(HERE, "..");

/** Every file that makes up the `/app/logs` surface. */
const SURFACE_FILES = [
  "lib/logs-filter.ts",
  "app/app/logs/page.tsx",
  "components/logs/LogsExplorer.tsx",
  "server/queries/logs.ts",
];

test("D65: the URL-contract literals exist in exactly one module for this surface", () => {
  const found: Record<string, string[]> = {};
  for (const rel of SURFACE_FILES) {
    const text = readFileSync(path.join(WEB_SRC, rel), "utf8");
    // Both quote forms, so a single-quoted restatement cannot slip past the
    // sweep (S2.2 L4 — a sweep is only as good as the spellings it hunts).
    const hits = ['"6h"', "'6h'", '"debug"', "'debug'"].filter((lit) => text.includes(lit));
    if (hits.length > 0) found[rel] = hits;
  }
  assert.deepEqual(
    found,
    {
      "lib/logs-filter.ts": ['"6h"', '"debug"'],
      // The ONE documented exception, and it is a different vocabulary: this is
      // the OTel `severity_text` value inside `SEVERITY_RANK`'s SQL, not a URL
      // parameter value — the wire spelling of a log record's own severity
      // name. It is single-quoted because it is SQL; the double-quoted URL form
      // must never appear here, which this expectation pins.
      "server/queries/logs.ts": ["'debug'"],
    },
    "a URL-contract default was restated outside `lib/logs-filter.ts` — the page and the bar can now disagree about what an absent parameter means (D65)",
  );
});

// D61: the infra table deep-links each pod into this surface. Pod intent is a
// FILTER, not free text — `/app/logs` free text reads the log body only
// (D51(e)) — so the link has to speak this contract's `pod` parameter with the
// pod's whole name. The old form searched a truncated prefix of the name in
// message text. The companion guard in `server/data.test.ts` proves the names
// it sends are names this surface can actually filter on.
test("D61: the infra pod link speaks the contract's pod parameter, whole name", () => {
  const infra = readFileSync(path.join(WEB_SRC, "app/app/infra/page.tsx"), "utf8");
  assert.ok(
    infra.includes("`/app/logs?pod=${encodeURIComponent(p.name)}`"),
    "the infra pod link no longer sends the whole pod name as this surface's `pod` filter (D61)",
  );
  assert.ok(
    !infra.includes("/app/logs?q="),
    "the infra pod link is back to free text, which on this surface searches log bodies and not pod names",
  );
  assert.ok(
    !infra.includes('p.name.split("-")'),
    "the pod name is being truncated again — a prefix is not a value the pod filter matches",
  );
  // The link's target has to parse as the pod filter, not merely look like it.
  assert.equal(parseLogsUrl({ pod: "agent-worker-7d9fb-kx2rq" }).pod, "agent-worker-7d9fb-kx2rq");
});

test("D65: the bar's dropdowns are generated from the contract, so they cannot offer a rejected value", () => {
  // Both option lists are derived in `LogsExplorer` from these two exports; if
  // either vocabulary grew a value the parser rejects, the control would set a
  // filter the page silently throws away.
  for (const range of Object.keys(LOG_RANGE_HOURS)) {
    assert.equal(parseLogsUrl({ range }).range, range, `the bar offers ${range} but the parser rejects it`);
  }
  for (const sev of SEVERITY_ORDER) {
    assert.equal(parseLogsUrl({ sev }).sev, sev, `the bar offers ${sev} but the parser rejects it`);
  }
});
