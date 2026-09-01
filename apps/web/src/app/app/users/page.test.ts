import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// run with: npm test --workspace apps/web
//
// D367's byte-identity claim ("rendered DOM byte-identical in mock mode")
// rests on two facts: `users/page.tsx`'s mock branch hands `UsersMock` ZERO
// props, and `UsersMock.tsx` is the untouched page body, moved verbatim.
// Neither is provable by IMPORTING the real modules here (the
// `explore/page.test.ts` situation does not apply the same way — these two
// components have no recharts/client-only dependency — but the house pattern
// is still source-text, per D391(a): "no @/mock/ in the live graph" is a
// SOURCE-TEXT rule on `UsersLive.tsx`, never a transitive-graph claim).
const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (file: string) => readFileSync(path.join(HERE, file), "utf8");
const PAGE = read("page.tsx");
const MOCK = read("../../../components/users/UsersMock.tsx");
const LIVE = read("../../../components/users/UsersLive.tsx");

test("the mock branch renders UsersMock, verbatim and with zero props, before any live-only read runs", () => {
  assert.ok(
    PAGE.includes('import { UsersMock } from "@/components/users/UsersMock";'),
    "page.tsx must import the moved mock component",
  );
  assert.match(
    PAGE,
    /if \(dataMode !== "live"\) return <UsersMock \/>;/,
    "the mock branch must return UsersMock with no props, and nothing else",
  );
  const mockBranch = PAGE.indexOf('if (dataMode !== "live")');
  const liveOnlyRead = PAGE.indexOf("await connection()");
  assert.ok(
    mockBranch >= 0 && liveOnlyRead > mockBranch,
    "the mock branch must return before the live-only session/connection reads run",
  );
});

test("UsersMock is the untouched page body, moved verbatim (D367)", () => {
  // Pinned markers from the original 104-line users/page.tsx body: if any of
  // these move or vanish, the "verbatim move" this test exists to catch has
  // drifted.
  for (const marker of [
    'from "@/mock/users"',
    "riskStyle",
    'data-tour="users"',
    "reqs · 7d",
    "INC-42",
  ]) {
    assert.ok(MOCK.includes(marker), `UsersMock lost "${marker}" — the moved body drifted from the original page`);
  }
});

test("A2/D392: the live component never imports mock data and never ships client JS (no \"use client\")", () => {
  assert.equal(
    LIVE.includes('from "@/mock/'),
    false,
    "UsersLive must not depend on any mock module",
  );
  assert.ok(
    !LIVE.includes('"use client"'),
    'UsersLive must be a SERVER component (D392) — every selection is a URL or a <Link>, never client-side interactivity',
  );
  assert.ok(LIVE.includes('data-tour="users"'), "UsersLive must carry the same data-tour anchor as the original surface (D404)");
});
