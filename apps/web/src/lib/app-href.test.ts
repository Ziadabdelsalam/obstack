import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { appHref, appHost } from "./app-href";

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

// R3 must-fix 1: the helper used to concatenate whatever the environment held,
// and `/` is PRERENDERED — a wrong value is not a runtime error some request
// surfaces, it is static HTML shipped to strangers. The two wrong values are
// the two that are easy to type, so both are pinned: one is normalized, the
// other is refused loudly enough that `next build` cannot get past it.
test("a trailing slash is normalized away, not baked into the href", () => {
  reset();
  process.env[VAR] = "https://app.obstack.dev/";
  assert.equal(appHref("/signup"), "https://app.obstack.dev/signup");
  process.env[VAR] = "https://app.obstack.dev///";
  assert.equal(appHref("/signup"), "https://app.obstack.dev/signup");
  // Surrounding whitespace is the same class of accident (a Docker `--build-arg`
  // that picked up a stray space) and is not a different value.
  process.env[VAR] = "  https://app.obstack.dev/  ";
  assert.equal(appHref("/signup"), "https://app.obstack.dev/signup");
  reset();
});

test("a scheme-less value is refused at build time, not baked in as a relative link", () => {
  // The dangerous one: `app.obstack.dev` + `/signup` is a RELATIVE href, so the
  // three CTAs would resolve against the marketing host and land back on the
  // dead-end page this helper exists to route around — with no error anywhere.
  reset();
  process.env[VAR] = "app.obstack.dev";
  assert.throws(() => appHref("/signup"), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /OBSTACK_APP_ORIGIN/, "the error must name the variable to fix");
    assert.match(err.message, /app\.obstack\.dev/, "the error must quote the value it refused");
    return true;
  });
  reset();
});

test("garbage, a non-http scheme and a query string are all refused", () => {
  reset();
  for (const bad of [
    "not a url at all",
    "://app.obstack.dev",
    "ftp://app.obstack.dev",
    "javascript:alert(1)",
    "file:///etc/passwd",
    "https://app.obstack.dev?next=1",
    "https://app.obstack.dev#top",
  ]) {
    process.env[VAR] = bad;
    assert.throws(
      () => appHref("/signup"),
      /OBSTACK_APP_ORIGIN/,
      `${JSON.stringify(bad)} was accepted as an app origin`,
    );
  }
  reset();
});

test("a valid origin with a base path still prefixes once", () => {
  // Not every deployment mounts the app at the root of its host; a base path is
  // legal input, and the trailing-slash rule is what makes it join cleanly.
  reset();
  process.env[VAR] = "https://obstack.dev/app/";
  assert.equal(appHref("/signup"), "https://obstack.dev/app/signup");
  process.env[VAR] = "http://localhost:3001";
  assert.equal(appHref("/app"), "http://localhost:3001/app");
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

// D340: the same env, read as a bare host rather than a link — the five
// hosting sentences on the auth/landing/invite pages derive from this.
test("appHost: unset yields null — nothing to render, the single-host default", () => {
  reset();
  assert.equal(appHost(), null);
});

test("appHost: set yields the host alone — no scheme, no path, no trailing slash", () => {
  reset();
  process.env[VAR] = "https://app.obstack.dev";
  assert.equal(appHost(), "app.obstack.dev");
  process.env[VAR] = "https://obstack.dev/app/";
  assert.equal(appHost(), "obstack.dev", "a mounted base path is not part of the host");
  process.env[VAR] = "http://localhost:3001";
  assert.equal(appHost(), "localhost:3001", "a port is part of the host");
  reset();
});

test("appHost: a malformed value is refused the same way appHref refuses it", () => {
  reset();
  process.env[VAR] = "app.obstack.dev";
  assert.throws(() => appHost(), /OBSTACK_APP_ORIGIN/);
  reset();
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
