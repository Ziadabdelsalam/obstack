import assert from "node:assert/strict";
import test from "node:test";
import { appHref } from "./app-href";

// run with: npm test --workspace apps/web
//
// D329 — two states, and the default is the one every deployment before S5
// runs: with no origin configured a cross-host link is the same relative path
// it has always been, so adding this helper changed no rendered byte on a
// single-host obstack. The configured state is the D262 marketing host, where
// the same button has to leave for the app's origin.

const VAR = "OBSTACK_APP_ORIGIN";

function reset(): void {
  delete process.env[VAR];
}

test("unset: the path, unchanged — a single-host obstack links to itself", () => {
  reset();
  assert.equal(appHref("/signup"), "/signup");
  assert.equal(appHref("/app"), "/app");
});

test("empty counts as unset, the way an unset ARG arrives from Docker", () => {
  // `ARG OBSTACK_APP_ORIGIN=` with no `--build-arg` gives the ENV an empty
  // string rather than removing it, so "" has to mean the same as absent or
  // the default build would emit "" + "/signup" by a different route and any
  // future non-concatenating change here would diverge between the two.
  reset();
  process.env[VAR] = "";
  assert.equal(appHref("/signup"), "/signup");
  reset();
});

test("set: the origin prefixes the path, once, with no separator invented", () => {
  reset();
  process.env[VAR] = "https://app.obstack.dev";
  assert.equal(appHref("/signup"), "https://app.obstack.dev/signup");
  assert.equal(appHref("/app"), "https://app.obstack.dev/app");
  reset();
});

test("the value is read per call, not captured at import", () => {
  // The helper is called during `next build` while the page renders, which is
  // after this module was first imported. A value read at module scope would
  // be whatever the environment held at import time — the same class of bug as
  // a snippet baked at module scope (D281) — so the read has to be inside the
  // function, and this is what says so.
  reset();
  assert.equal(appHref("/signup"), "/signup");
  process.env[VAR] = "https://app.obstack.dev";
  assert.equal(appHref("/signup"), "https://app.obstack.dev/signup");
  reset();
  assert.equal(appHref("/signup"), "/signup");
});
