import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { resolvedImports } from "@/test-utils/import-specifiers";

// run with: npm test --workspace apps/web
//
// The account surface's SHAPE, read as source text (the `users/page.test.ts`
// idiom, D391(a)): the mock branch returns before any live-only read, the live
// body is a server component with no mock import, and every write it offers is
// one of the five actions the mock-mode shim (`signup/mock-mode.test.ts`)
// proves trip in mock mode. The rendered mock tree itself is asserted there,
// under that file's `createContext` shim — the shim of record (D156).

const HERE = path.dirname(fileURLToPath(import.meta.url));
const resolve = (file: string) => path.join(HERE, file);
const read = (file: string) => readFileSync(resolve(file), "utf8");
const PAGE = read("page.tsx");
const ACTIONS = read("actions.ts");
const LIVE_PATH = resolve("../../../components/account/AccountLive.tsx");
const LIVE = readFileSync(LIVE_PATH, "utf8");

test("the mock branch returns before any live-only read runs (D125/D150)", () => {
  const mockBranch = PAGE.indexOf('if (dataMode !== "live") {');
  const liveOnlyRead = PAGE.indexOf("await connection()");
  assert.ok(mockBranch >= 0 && liveOnlyRead > mockBranch, "the mock branch must return before connection()");
  assert.ok(PAGE.indexOf("await searchParams") > liveOnlyRead, "searchParams is a request-time read and stays below the mode check");
  // The mock branch offers nothing to submit — the tree test asserts the same
  // of the rendered elements; this is the source-side half.
  const branch = PAGE.slice(mockBranch, liveOnlyRead);
  assert.ok(branch.includes("return ("), "the mock branch returns its tree inline, where the shim can walk it");
  assert.ok(!branch.includes("<form") && !branch.includes("<input") && !branch.includes("<button"));
});

test("the live body is a server component with no mock import and the tour anchor (D392)", () => {
  assert.ok(!LIVE.includes('"use client"'), "AccountLive must be a SERVER component — every control is a form");
  assert.equal(
    resolvedImports(LIVE, LIVE_PATH).some((spec) => /(^|\/)mock\//.test(spec)),
    false,
    "AccountLive must not depend on any mock module",
  );
  assert.ok(LIVE.includes('data-tour="account"'));
});

test("every form on the live body posts to one of the five gated actions, and every action is offered", () => {
  const offered = [...LIVE.matchAll(/<form action=\{(\w+)\}/g)].map((m) => m[1]).sort();
  assert.deepEqual([...new Set(offered)], [
    "revokeOtherSessions",
    "revokeSession",
    "updateEmail",
    "updateName",
    "updatePassword",
  ]);
  const exported = [...ACTIONS.matchAll(/export async function (\w+)\(/g)].map((m) => m[1]).sort();
  assert.deepEqual(exported, [...new Set(offered)], "an action exists that no form posts to, or a form posts to nothing");
  // Every action opens with the one gate — the mode tripwire ahead of the
  // session read (D152) — counted, so a sixth action cannot skip it silently.
  assert.equal((ACTIONS.match(/await accountSession\(/g) ?? []).length, exported.length);
});

test("the session list never hands the page a token, and the current session has no revoke form", () => {
  // The view type is the contract: `SessionView` carries an id and never a
  // token, and the component reads only what the type names.
  const types = readFileSync(resolve("../../../lib/account-types.ts"), "utf8");
  const view = types.slice(types.indexOf("export interface SessionView"), types.indexOf("export interface MembershipView"));
  assert.ok(!/\btoken\b/.test(view.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")), "SessionView must not carry a token field");
  assert.ok(!/\btoken\b/i.test(LIVE), "the component must not mention a token at all");
  // The current row says where to sign out instead of offering the list's
  // revoke; the predicate in `server/account.ts` refuses it anyway (D711).
  assert.ok(LIVE.includes("session.current ? ("), "the current session is not branched on");
  assert.ok(LIVE.includes("sign out from the top bar"));
});
