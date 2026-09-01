import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { HOSTILE_URL_VALUES, type HostileUrlValue } from "@/lib/hostile-url-values";
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

// ---- D68 totality: the shared hostile corpus, every value in every parameter

/** Short, stable label for a message — the corpus holds a 5000-character value. */
function label(value: HostileUrlValue): string {
  if (Array.isArray(value)) return `[${value.join(",")}]`;
  return value.length > 24 ? `${value.slice(0, 24)}…(${value.length} chars)` : JSON.stringify(value);
}

/**
 * The two kinds of parameter this contract has, split by what "in domain"
 * MEANS for each — the split is the property, not a convenience:
 *
 * - CLOSED parameters (`sev`, `range`, `onTrace`) hold one of a fixed set, so
 *   hostile input can never become the value; it must fall back to the default.
 * - OPEN parameters (`q`, `pod`) must ACCEPT the input verbatim. `?q=toString`
 *   is a real body search and `?pod=__proto__` is a real pod filter that finds
 *   nothing; asserting a default fallback there would assert a falsehood (D68).
 *
 * This contract has no NUMERIC parameter, so D68's numeric-bounds clause has
 * nothing to bind to directly — but the parse DERIVES one number, the time
 * window, and that is precisely where the measured failure was: `?range=
 * toString` under `range in LOG_RANGE_HOURS` walked the prototype chain to a
 * Function, made `since_ms` NaN and 500'd the route in live mode. So `rangeMs`
 * is asserted finite and positive for every value in every parameter, and
 * restoring `in` turns this test red.
 */
const CLOSED_PARAMS = ["sev", "range", "onTrace"] as const;
const OPEN_PARAMS = ["q", "pod"] as const;

test("D68 totality: no corpus value in any parameter escapes the contract's domain", () => {
  // S2.0 L1: everything below is a loop, and a loop over an empty corpus is
  // green by vacuity. The fixture's size and its load-bearing members are
  // asserted BEFORE anything iterates, so a corpus that shrank — or lost the
  // prototype names that caused the real 500 — is a failure here rather than a
  // silently weaker guarantee everywhere it is inherited.
  assert.equal(HOSTILE_URL_VALUES.length, 15, "the D68 corpus changed size; the ruling fixes its contents");
  for (const required of ["toString", "constructor", "valueOf", "hasOwnProperty", "__proto__", "1e999", "NaN", ""]) {
    assert.ok(HOSTILE_URL_VALUES.includes(required), `the corpus lost ${JSON.stringify(required)}`);
  }
  assert.ok(
    HOSTILE_URL_VALUES.some((v) => Array.isArray(v)),
    "the corpus lost its repeated-parameter value — the one shape only a router produces",
  );
  assert.ok(
    HOSTILE_URL_VALUES.some((v) => typeof v === "string" && v.length >= 5000),
    "the corpus lost its long value",
  );

  for (const value of HOSTILE_URL_VALUES) {
    for (const param of [...CLOSED_PARAMS, ...OPEN_PARAMS]) {
      const at = `?${param}=${label(value)}`;

      // (a) never throws
      const parsed = ((): LogsFilters => {
        try {
          return parseLogsUrl({ [param]: value });
        } catch (error) {
          assert.fail(`${at} threw ${String(error)} — a parse must never throw (D68)`);
        }
      })();

      // (b) in-domain: the closed fields hold a member of their vocabulary AND,
      // because no corpus value is a legal member, their default.
      assert.ok(SEVERITY_ORDER.includes(parsed.sev), `${at} left sev outside its vocabulary: ${parsed.sev}`);
      assert.ok(Object.hasOwn(LOG_RANGE_HOURS, parsed.range), `${at} left range outside its vocabulary: ${parsed.range}`);
      assert.equal(parsed.sev, DEFAULT_LOG_SEVERITY, `${at} did not fall back to the default severity`);
      assert.equal(parsed.range, DEFAULT_LOG_RANGE, `${at} did not fall back to the default range`);
      assert.equal(parsed.onTrace, false, `${at} did not fall back to the default on-trace toggle`);

      // The derived bound — the one number this contract produces, and the one
      // the query layer subtracts from the clock.
      const rangeMs = toLogFilter(parsed).rangeMs;
      assert.ok(
        typeof rangeMs === "number" && Number.isFinite(rangeMs) && rangeMs > 0,
        `${at} produced a non-finite or non-positive window: ${rangeMs}`,
      );

      // The open fields accept the value — first-of-repeated, trimmed — and the
      // parameter that was not attacked stays empty.
      const accepted = (Array.isArray(value) ? value[0] : value).trim();
      const untouched = param === "q" ? "pod" : "q";
      if (param === "q" || param === "pod") {
        assert.equal(parsed[param], accepted, `${at} rejected a legitimate free-string value`);
        assert.equal(parsed[untouched], "", `${at} leaked into ${untouched}`);
      } else {
        assert.equal(parsed.q, "", `${at} leaked into q`);
        assert.equal(parsed.pod, "", `${at} leaked into pod`);
      }

      // ...and whatever survived round-trips through the URL unchanged, so an
      // accepted hostile string cannot mean one thing in a link and another in
      // the bar that re-serializes it.
      assert.deepEqual(
        parseLogsUrl(Object.fromEntries(new URLSearchParams(logsSearchString(parsed)))),
        parsed,
        `${at} did not survive a serialize/parse round trip`,
      );
    }
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
//
// The surface's files are enumerated by GLOB, never by hand (S6.3-L1): D367
// split `/app/infra` into a mock half and a live half, and a guard naming one
// file leaves the other free to reopen exactly this. The LIVE half is the one
// that has to carry the link — a mock-only assertion would go green on a live
// page that dropped it — so it is named as the positive control, while the ban
// runs over every file the glob found.
test("D61: the infra pod link speaks the contract's pod parameter, whole name", () => {
  const dir = path.join(WEB_SRC, "components/infra");
  const sources = new Map(
    readdirSync(dir)
      .filter((f) => f.endsWith(".tsx"))
      .map((f) => [f, readFileSync(path.join(dir, f), "utf8")] as const),
  );
  assert.ok(
    sources.has("InfraLive.tsx") && sources.size >= 2,
    `the sweep did not find the infra surface's files (read: ${[...sources.keys()].join(", ")})`,
  );
  assert.ok(
    sources.get("InfraLive.tsx")!.includes("`/app/logs?pod=${encodeURIComponent(p.name)}`"),
    "the LIVE infra pod link no longer sends the whole pod name as this surface's `pod` filter (D61)",
  );
  for (const [file, src] of sources) {
    assert.ok(
      !src.includes("/app/logs?q="),
      `${file}'s pod link is back to free text, which on this surface searches log bodies and not pod names`,
    );
    assert.ok(
      !src.includes('p.name.split("-")'),
      `${file} truncates the pod name again — a prefix is not a value the pod filter matches`,
    );
  }
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
