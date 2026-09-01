import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// run with: npm test --workspace apps/web
//
// The `explore/page.test.ts` guard, applied to issues (A3). It reads SOURCE
// rather than importing: `IssuesMock`/`IssuesLive` pull in `next/link` and
// `lucide-react`, which throw at module scope under `--conditions
// react-server` (no `createContext`), so a source-text test is the house
// fallback for exactly this situation (D54(iii)).
//
// D391(a) bounds what can be claimed here: "no `@/mock/` in the live graph" is
// a source-text rule on `IssuesLive.tsx`, never a transitive-graph claim —
// `server/data.ts` statically imports `@/mock/*` and always will.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (file: string) => readFileSync(path.join(HERE, file), "utf8");
const PAGE = read("page.tsx");
const MOCK = read("../../../components/issues/IssuesMock.tsx");
const LIVE = read("../../../components/issues/IssuesLive.tsx");

test("the mock branch renders IssuesMock, verbatim and with zero props, before any live-only read runs", () => {
  assert.ok(
    PAGE.includes('import { IssuesMock } from "@/components/issues/IssuesMock";'),
    "page.tsx must import the moved mock component",
  );
  assert.match(
    PAGE,
    /if \(dataMode !== "live"\) return <IssuesMock \/>;/,
    "the mock branch must return IssuesMock with no props, and nothing else",
  );
  const mockBranch = PAGE.indexOf('if (dataMode !== "live")');
  const firstAwait = PAGE.indexOf("await ");
  assert.ok(
    mockBranch >= 0 && firstAwait > mockBranch,
    "the mock branch must return before the live-only session/connection reads run",
  );
  assert.equal(
    PAGE.includes('from "@/mock/'),
    false,
    "the page itself needs no mock import — IssuesMock owns the fixture now",
  );
});

test("IssuesMock is the untouched page body — it takes no props and reads the fixture itself", () => {
  assert.match(MOCK, /export function IssuesMock\(\)\s*\{/, "IssuesMock must take no props");
  // Pinned markers from the original 84-line issues/page.tsx body: if any of
  // these move or vanish, the "verbatim move" this test exists to catch has
  // drifted (the integrator proves byte-identity of the rendered DOM).
  for (const marker of [
    'import { issues } from "@/mock/issues";',
    "function Spark({ data, hot }: { data: number[]; hot: boolean })",
    "grouped by error fingerprint",
    'data-tour="issues"',
    "issue.count7d",
    "issue.exampleLink!",
    "× in 7d",
  ]) {
    assert.ok(MOCK.includes(marker), `IssuesMock lost "${marker}" — the moved body drifted from the original page`);
  }
});

test("A2/D392: the live branch imports no mock data and ships no client JavaScript", () => {
  assert.equal(LIVE.includes('from "@/mock/'), false, "IssuesLive must not depend on any mock module");
  assert.equal(
    LIVE.includes('"use client"'),
    false,
    "IssuesLive is a server component (D392) — there is no interactivity here to hydrate",
  );
  assert.equal(
    LIVE.includes("count7d"),
    false,
    "the fixture's 7-day count has no live equivalent — the live count is the 24h window's (D394)",
  );
});

test("D361: the live surface offers no assign, mute or resolve — the fence is stated, not implemented", () => {
  for (const forbidden of ["Assign", "Mute", "Snooze", "Ignore", "Acknowledge", "Mark as resolved"]) {
    assert.equal(
      LIVE.includes(forbidden),
      false,
      `IssuesLive offers "${forbidden}" — this build stores no per-issue state (D361)`,
    );
  }
  // The one thing that must be SAID: status is recency, against D50's 6h.
  assert.ok(LIVE.includes("RECENT_HOURS"), "the legend must state the recency window it uses");
  assert.ok(LIVE.includes("Status is"), "the surface must state what status means");
});

test("D394/D402/D404: the window, the cap statement and the tour anchor are all on the live surface", () => {
  assert.ok(LIVE.includes("WINDOW_HOURS"), "the live surface must state the window in words (D394)");
  assert.ok(
    LIVE.includes("showing top {issues.length} of {total}"),
    "the cap banner must state the truncation the read applied (D402)",
  );
  assert.ok(LIVE.includes('data-tour="issues"'), "the live surface keeps the tour anchor (D404)");
});

test("D423(b): an unnamed service renders the house absence glyph, not an empty string", () => {
  assert.ok(
    LIVE.includes('issue.service || "—"'),
    'IssuesLive must render issue.service with the "—" fallback for an empty service (D423(b))',
  );
});
