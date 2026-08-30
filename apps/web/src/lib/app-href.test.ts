import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
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

// R2 should-fix 4/5: both docblocks that state this helper's scope said "two"
// while the page rendered three — the hero grew a CTA and the prose stayed
// where it was. A number written in two files and checked in neither is a
// number that drifts, so the page is the source and the two prose copies are
// mirrored against it (the D206 shape).
test("the scope the docblocks claim is the scope the page gives this helper", () => {
  const HERE = import.meta.dirname;
  const page = readFileSync(path.join(HERE, "../app/page.tsx"), "utf8");

  const wrapped = [...page.matchAll(/href=\{appHref\("([^"]+)"\)\}/g)].map((m) => m[1]);
  assert.deepEqual(wrapped, ["/signup", "/signup", "/signup"], "the set of cross-host links on / changed");
  assert.equal(
    page.split("Create your workspace").length - 1,
    wrapped.length,
    "a `Create your workspace` button is not wrapped in appHref, or a wrapped link is not that button",
  );

  const WORDS = ["no", "one", "two", "three", "four", "five"];
  const spelled = WORDS[wrapped.length];
  assert.ok(spelled, `${wrapped.length} buttons — spell it in WORDS above and update both docblocks`);
  for (const [name, file] of [
    ["lib/app-href.ts", path.join(HERE, "app-href.ts")],
    ["apps/web/Dockerfile", path.join(HERE, "../../Dockerfile")],
  ]) {
    const src = readFileSync(file, "utf8");
    assert.match(
      src,
      new RegExp(`${spelled} "Create your workspace" buttons`),
      `${name} does not say there are ${spelled} "Create your workspace" buttons, and the page renders ${spelled}`,
    );
  }
});
