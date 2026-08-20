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

// The empty state is about EVENTS, not rows: a workspace that issued three keys
// and sent nothing has three health rows and zero sources. Red-provable by
// returning the list unfiltered — the panel would then list credentials as
// connected sources and never show the empty state at all.
test("a key with no events is not a connected source", () => {
  const sources = [
    source({ keyId: "k1" }),
    source({ keyId: "k2", accepted: 12, lastEvent: "2026-08-20 13:40 UTC" }),
    source({ keyId: "k3" }),
  ];
  assert.deepEqual(
    connectedSourcesOf(sources).map((s) => s.keyId),
    ["k2"],
  );
  // A workspace with keys but no events: zero sources, so the panel renders
  // the "no sources yet" content instead of a list.
  assert.deepEqual(connectedSourcesOf([source({ keyId: "k1" }), source({ keyId: "k3" })]), []);
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

// T3 done-check: the staleness statement is rendered, and it is the read's own
// `asOf` (D162) — with the honest alternative when nothing has ever arrived.
test("the live panel renders the as-of and never a fabricated rate", () => {
  assert.ok(hubSource.includes("as of ${data.asOf}"), "the live panel must show its as-of");
  assert.ok(hubSource.includes("no events on any key yet"));
  // `/min` survives in the demo rows only: the D100 counters are cumulative,
  // so a per-minute number derived from them would be invented (D165 posture).
  const perMin = hubSource.split("\n").filter((l) => l.includes("/min"));
  assert.deepEqual(
    perMin.map((l) => l.trim()),
    ["{s.ratePerMin.toLocaleString()}/min"],
  );
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
