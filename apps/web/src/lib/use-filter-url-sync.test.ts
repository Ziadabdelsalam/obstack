import assert from "node:assert/strict";
import test from "node:test";
import { URL_SYNC_DEBOUNCE_MS, pushedUrl, syncUrl, type UrlSync } from "./use-filter-url-sync";

// run with: npm test --workspace apps/web
//
// D72: the URL-echo rule, once, for both bars. These assertions used to live in
// `traces-filter.test.ts` and covered only the traces surface; they are here
// now because the logic is here, and `/app/logs` — which had its own, weaker
// version — is covered by the same cases (the "re-pointed" mutation assertion).
// The hook wrapper is not asserted here: it is thin by construction and its
// coverage of record is T5's browser run (D72, D54(iii) authority).

const mounted: UrlSync = { seen: "q=pool", pending: [] };

test("a URL the bar did not produce is adopted (carry-forward 2)", () => {
  // Back/forward, a link into a filtered view, a view applied elsewhere.
  const external = syncUrl(mounted, "status=error");
  assert.equal(external.adopt, true);
  assert.deepEqual(external.sync, { seen: "status=error", pending: [] });

  // A re-render with the same URL is not a change at all.
  assert.deepEqual(syncUrl(mounted, "q=pool"), { adopt: false, sync: mounted });
});

test("the bar's own echo is ignored exactly once, and consumed from the list", () => {
  const pushed = pushedUrl(mounted, "q=pooled");
  assert.deepEqual(pushed, { seen: "q=pool", pending: ["q=pooled"] });

  const echo = syncUrl(pushed, "q=pooled");
  assert.equal(echo.adopt, false);
  assert.deepEqual(echo.sync, { seen: "q=pooled", pending: [] });

  // Only once: the same URL reached again later is somebody else's navigation.
  assert.equal(syncUrl({ seen: "q=other", pending: [] }, "q=pooled").adopt, true);
});

/**
 * The measured defect this module exists for, as the reviewer traced it on
 * `/app/logs`: type "ab", the bar navigates; type "c" before the first render
 * comes back, the bar navigates again; THEN the echo of "ab" lands.
 *
 * With one remembered URL — the shape the logs bar shipped — the second push
 * overwrites the first, the late echo of "ab" no longer matches what is
 * remembered, so it reads as an external navigation, is adopted, and the typed
 * "c" is silently rewound. With the list, the echo finds itself, is consumed,
 * and the second edit survives; the second echo then settles the bar.
 */
test("a late echo of an earlier edit does not rewind the later one (D72)", () => {
  const first = pushedUrl(mounted, "q=ab");
  const second = pushedUrl(first, "q=abc");
  assert.deepEqual(second.pending, ["q=ab", "q=abc"]);

  const lateEcho = syncUrl(second, "q=ab");
  assert.equal(lateEcho.adopt, false, "the late echo was adopted — the typed text is gone");
  assert.deepEqual(lateEcho.sync.pending, ["q=abc"], "the echo was not consumed by itself");
  assert.equal(lateEcho.sync.seen, "q=ab");

  // ...and the still-pending later edit settles the bar when its own render
  // arrives, rather than being adopted as if a stranger had navigated.
  const settling = syncUrl(lateEcho.sync, "q=abc");
  assert.equal(settling.adopt, false);
  assert.deepEqual(settling.sync, { seen: "q=abc", pending: [] });
});

test("adopting clears the list: an echo for the URL the bar left is not about its state", () => {
  assert.deepEqual(syncUrl(pushedUrl(mounted, "q=stale"), "range=1h"), {
    adopt: true,
    sync: { seen: "range=1h", pending: [] },
  });
});

test("the debounce that coalesces a typed word is one constant, shared", () => {
  // M1 behaviour on both surfaces (D72: "the 250ms debounce constant stays").
  // Pinned as a literal so a change here is a decision, not a drift.
  assert.equal(URL_SYNC_DEBOUNCE_MS, 250);
});
