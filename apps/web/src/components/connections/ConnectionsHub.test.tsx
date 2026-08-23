import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// run with: npm test --workspace apps/web
//
// The connected panel's derivations, driven directly. `ConnectionsHub.tsx` is a
// `"use client"` module and the runner is pinned to `--conditions react-server`
// (D54(ii)): its top-level `next/link` and `lucide-react` imports both call
// `createContext`, which that React build does not have. The decisions under
// test are pure, so this file stubs the two poison specifiers at the CJS
// `require` seam tsx compiles the imports to — the `qa-a5-banner.test.tsx`
// pattern — loads the module, and asserts the exported functions alone. The
// component body is never run; the rendered markup is pinned by source
// assertions where a fact has no function to ask (there is no DOM harness in
// this repo, D54(iii)).
const origLoad = (Module as unknown as { _load: (r: string, ...a: unknown[]) => unknown })._load;
(Module as unknown as { _load: (r: string, ...a: unknown[]) => unknown })._load = function (
  request: string,
  ...rest: unknown[]
) {
  if (request === "next/link") return { __esModule: true, default: () => null };
  if (request === "lucide-react") return { __esModule: true, Search: () => null };
  return origLoad.call(this, request, ...rest);
};

const { connectedSourcesOf, liveSourceStatus, sourceErrors } = createRequire(
  fileURLToPath(import.meta.url),
)("./ConnectionsHub.tsx") as typeof import("./ConnectionsHub");

type LiveSource = Parameters<typeof sourceErrors>[0];

const source = (overrides: Partial<LiveSource> & { keyId: string }): LiveSource => ({
  name: "Quickstart",
  prefix: "ok_live_ab12",
  revoked: false,
  accepted: 0,
  droppedDecode: 0,
  droppedUnsupported: 0,
  droppedQuota: 0,
  lastEvent: null,
  ratePerMin: null,
  ...overrides,
});

const hubSource = readFileSync(
  path.join(import.meta.dirname, "ConnectionsHub.tsx"),
  "utf8",
);

// The exit criterion asks connected sources to show errors from real counters,
// and `server/ingest-health.ts` states which drops those are: decode plus
// unsupported. Quota drops are the plan's sampling working as designed — adding
// them here would tell an operator their exporter is broken on a workspace
// whose only "problem" is the tier it bought (D162).
test("errors are the receive-path drops and never the quota ones", () => {
  const s = source({ keyId: "k1", accepted: 900, droppedDecode: 3, droppedUnsupported: 4, droppedQuota: 1_000 });
  assert.equal(sourceErrors(s), 7);
  // The control: with no receive-path drops a sampled-out workspace is clean.
  assert.equal(sourceErrors(source({ keyId: "k2", droppedQuota: 5_000 })), 0);
});

// The empty state is about RECORDS, not rows: a workspace that issued three keys
// and sent nothing has zero sources. Red-provable by returning the list
// unfiltered — the panel would then list credentials as connected sources and
// never show the empty state at all.
test("a key nothing was ever counted on is not a connected source", () => {
  const sources = [
    source({ keyId: "k1" }),
    source({ keyId: "k2", accepted: 12, lastEvent: "2026-08-20 13:40 UTC" }),
    source({ keyId: "k3" }),
  ];
  assert.deepEqual(
    connectedSourcesOf(sources).map((s) => s.keyId),
    ["k2"],
  );
  // A workspace with keys but no records: zero sources, so the panel renders
  // the "no sources yet" content instead of a list.
  assert.deepEqual(connectedSourcesOf([source({ keyId: "k1" }), source({ keyId: "k3" })]), []);
});

// The case the panel exists for: an exporter that has been sending all along
// and had every record rejected. `last_event_at` stays NULL through a
// drops-only flush (`metering.go`'s GREATEST), so a filter on arrival alone
// would answer "nothing has reached this workspace" to the one operator with a
// real problem — and to the one whose plan quota sampled everything out.
test("a key that only ever dropped records is a source, and a broken one", () => {
  const rejected = source({ keyId: "k1", droppedDecode: 4_000 });
  const sampledOut = source({ keyId: "k2", droppedQuota: 900 });
  assert.deepEqual(
    connectedSourcesOf([rejected, sampledOut, source({ keyId: "k3" })]).map((s) => s.keyId),
    ["k1", "k2"],
  );
  assert.equal(liveSourceStatus(rejected), "degraded");
  // Nothing accepted is not "healthy", and quota sampling is not a fault.
  assert.equal(liveSourceStatus(sampledOut), "silent");
  // Such a row has no last event to print, and says so.
  assert.ok(hubSource.includes('{s.lastEvent ?? "never"}'));
});

// What the dot says. A source only reaches the panel once it has events, so
// "silent" cannot happen here; a revoked key that carried events is listed and
// said to be revoked rather than shown as healthy.
test("status is derived from the counters, not asserted", () => {
  const arrived = { accepted: 500, lastEvent: "2026-08-20 13:40 UTC" };
  assert.equal(liveSourceStatus(source({ keyId: "k1", ...arrived })), "healthy");
  assert.equal(
    liveSourceStatus(source({ keyId: "k2", ...arrived, droppedUnsupported: 2 })),
    "degraded",
  );
  assert.equal(liveSourceStatus(source({ keyId: "k3", ...arrived, droppedDecode: 1 })), "degraded");
  assert.equal(liveSourceStatus(source({ keyId: "k4", ...arrived, revoked: true })), "revoked");
  // Sampling is not a fault (same basis as `sourceErrors`).
  assert.equal(liveSourceStatus(source({ keyId: "k5", ...arrived, droppedQuota: 9_000 })), "healthy");
});

// T3 done-check, asserted: the live surface may not import mock data (D125/
// D158 class). The demo rows reach this component as props from the page.
test("the hub imports no mock data", () => {
  assert.equal(hubSource.includes('from "@/mock/connectors"'), false);
  assert.match(hubSource, /import type \{ ConnectedSource \} from "@\/mock\/types"/);
});

// The staleness statement is rendered, and it is the read's own `asOf` (D162) —
// with the honest alternative when nothing has ever arrived.
test("the live panel renders the as-of", () => {
  assert.ok(hubSource.includes("as of ${data.asOf}"), "the live panel must show its as-of");
  assert.ok(hubSource.includes("no events on any key yet"));
});

// D260 supersedes D218's refusal: the live rate is no longer absent because it
// would be invented — it is MEASURED from the windowed rows the metering flush
// writes, and the panel says which window it was measured over. What must never
// return is a rate derived from the cumulative counters.
test("the live rate is measured over a stated window, never derived from totals", () => {
  assert.ok(
    hubSource.includes("formatRate(s.ratePerMin)"),
    "the live rows must render the measured rate",
  );
  assert.ok(
    hubSource.includes("over the last ${data.rateWindowMinutes} complete minutes"),
    "the panel must state the window the rate was measured over",
  );
  // The cumulative totals stay what they are and are still said to be
  // cumulative — two different facts, each named (D260).
  assert.ok(hubSource.includes("accepted and sampled are cumulative per key"));
  // Nothing divides a lifetime counter to make a rate.
  assert.ok(
    !/accepted\s*\/\s*\w/.test(hubSource),
    "a rate must never be derived from the cumulative accepted count",
  );
});

// A key with no bucket in the window reads as an absence, never as a zero
// nothing measured — the distinction D218 refused to blur.
test("formatRate distinguishes no measurement from a measured zero", () => {
  const { formatRate } = createRequire(fileURLToPath(import.meta.url))(
    "./ConnectionsHub.tsx",
  ) as typeof import("./ConnectionsHub");

  assert.equal(formatRate(null), "—");
  assert.equal(formatRate(0), "0/min");
  assert.equal(formatRate(2.4), "2.4/min");
  assert.equal(formatRate(8420), "8,420/min");
});

// D212: the tour step points at this section by attribute; the rewrite keeps it.
test("the tour anchor survives the rewrite", () => {
  assert.match(hubSource, /data-tour="connections"/);
  const tour = readFileSync(
    path.join(import.meta.dirname, "../shell/TourGuide.tsx"),
    "utf8",
  );
  assert.ok(tour.includes('"connections"'), "TourGuide no longer targets this anchor");
});
