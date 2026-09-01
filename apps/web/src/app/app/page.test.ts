import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// run with: npm test --workspace apps/web
//
// `app/app/page.tsx` mixes live and mock content ternary-by-ternary rather
// than branching whole (unlike the D367 "mock returns before any await"
// shape T3/T5 use elsewhere) — it ALSO renders live-real stat cards beside a
// still-sample table, so a page-wide mock/live split does not fit. This guard
// reads SOURCE, the `issues/page.test.ts` fallback (D54(iii)): `WatchWidgets`
// (mock) and `WatchWidgetsLive` (client-tree recharts) both throw at module
// scope under `--conditions react-server`.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (file: string) => readFileSync(path.join(HERE, file), "utf8");
const PAGE = read("page.tsx");
const WATCH_LIVE = read("../../components/dash/WatchWidgetsLive.tsx");

test("D425/D434: the watch slot renders WatchWidgetsLive in live mode and WatchWidgets in mock, SampleWidget is gone", () => {
  assert.ok(
    PAGE.includes("live ? <WatchWidgetsLive pinned={pinned} loads={loads} /> : <WatchWidgets />"),
    "the watch slot's ternary must be exactly the D434 rewrite",
  );
  assert.ok(PAGE.includes("<WatchWidgetsLive"), "the live branch must render WatchWidgetsLive");
  assert.ok(PAGE.includes("<WatchWidgets />"), "the mock branch must still render WatchWidgets, untouched");
  assert.equal(
    PAGE.includes("function SampleWidget"),
    false,
    "SampleWidget is dead code once its one consumer (the watch slot wrapper) is gone (D434) — delete it",
  );
  assert.ok(
    PAGE.includes("SAMPLE_TITLE"),
    "SAMPLE_TITLE stays — the ingesting-status header and the top-failing card still use it",
  );
});

test("D428/D438: WatchWidgetsLive is a props-fed server component, zero mock/store imports", () => {
  assert.equal(
    WATCH_LIVE.includes('"use client"'),
    false,
    "WatchWidgetsLive is a server component (D428) — there is no interactivity here to hydrate",
  );
  assert.equal(WATCH_LIVE.includes('from "@/mock/'), false, "WatchWidgetsLive must not import any mock module");
  assert.equal(
    WATCH_LIVE.includes("workspace-store"),
    false,
    "WatchWidgetsLive must not read the in-memory dashboards store — D425 is a Postgres-backed view",
  );
  assert.ok(
    // The ROOT element, not the mention of it in the file's doc comment: the
    // anchor only spotlights anything if it is on rendered DOM (D434).
    WATCH_LIVE.includes('<div data-tour="watches">'),
    "WatchWidgetsLive's root must carry the same tour anchor as the mock WatchWidgets, so the tour spotlights something in live mode too",
  );
});
