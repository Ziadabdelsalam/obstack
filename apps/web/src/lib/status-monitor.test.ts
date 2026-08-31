import assert from "node:assert/strict";
import test from "node:test";
import { statusMonitorUrl } from "./status-monitor";

// run with: npm test --workspace apps/web
//
// D342 — the same two states as `app-href.test.ts`'s D329 helper, and the
// same reason: `/status` is prerendered, so this is read once while `next
// build` renders the page and baked into the static HTML. Unset is the
// default and every deployment until the Better Stack URL exists (K9); the
// page then says plainly that it publishes no external monitor rather than
// D256's original time-bound sentence.

const VAR = "OBSTACK_STATUS_MONITOR_URL";

function reset(): void {
  delete process.env[VAR];
}

test("unset: no monitor configured, and the page owes no link", () => {
  reset();
  assert.equal(statusMonitorUrl(), null);
});

test("empty counts as unset, the way an unset ARG arrives from Docker", () => {
  // `ARG OBSTACK_STATUS_MONITOR_URL=` with no `--build-arg` gives the ENV an
  // empty string rather than removing it — the same D329 concern this
  // helper's shape was copied to avoid repeating.
  reset();
  process.env[VAR] = "";
  assert.equal(statusMonitorUrl(), null);
  reset();
});

test("set: a trailing slash is normalized away, not baked into the href", () => {
  reset();
  process.env[VAR] = "https://x.y/";
  assert.equal(statusMonitorUrl(), "https://x.y");
  process.env[VAR] = "https://x.y///";
  assert.equal(statusMonitorUrl(), "https://x.y");
  process.env[VAR] = "  https://x.y/  ";
  assert.equal(statusMonitorUrl(), "https://x.y");
  reset();
});

test("http: is refused — a status page is never legitimately plain HTTP", () => {
  reset();
  process.env[VAR] = "http://x.y";
  assert.throws(() => statusMonitorUrl(), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /OBSTACK_STATUS_MONITOR_URL/, "the error must name the variable to fix");
    assert.match(err.message, /http:/, "the error must say which scheme it refused");
    return true;
  });
  reset();
});

test("garbage and other schemes are refused, naming the variable", () => {
  reset();
  for (const bad of ["not a url", "ftp://x.y", "javascript:alert(1)", "x.y"]) {
    process.env[VAR] = bad;
    assert.throws(
      () => statusMonitorUrl(),
      /OBSTACK_STATUS_MONITOR_URL/,
      `${JSON.stringify(bad)} was accepted as a monitor URL`,
    );
  }
  reset();
});

test("the value is read per call, not captured at import", () => {
  // The helper is called during `next build` while `/status` renders, which
  // is after this module was first imported — the same D329 discipline
  // `app-href.ts` documents, checked the same way here.
  reset();
  assert.equal(statusMonitorUrl(), null);
  process.env[VAR] = "https://x.y";
  assert.equal(statusMonitorUrl(), "https://x.y");
  reset();
  assert.equal(statusMonitorUrl(), null);
});
