import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { STAMP_PATH, assertModeStamp, checkModeStampOnBoot, readModeStamp } from "./mode-stamp";

// run with: npm test --workspace apps/web
//
// The red-then-green matrix for D251(b)/D265(a2)/D267's four boot outcomes.
// `docker build`/`docker run` proves the same outcomes against the real
// artifact (T1's done-check); this file proves the decision logic in
// isolation, including the two outcomes (mismatch, missing secret) that are
// awkward to provoke by actually building two images per assertion.

function tmpStampFile(contents?: string): { dir: string; file: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "obstack-mode-stamp-"));
  const file = path.join(dir, ".obstack-mode-stamp");
  if (contents !== undefined) writeFileSync(file, contents);
  return { dir, file };
}

test("readModeStamp: absent file is undefined, not an error", () => {
  const { dir, file } = tmpStampFile();
  try {
    assert.equal(readModeStamp(file), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readModeStamp: reads back a live or mock stamp, trimmed", () => {
  const live = tmpStampFile("live\n");
  const mock = tmpStampFile("mock");
  try {
    assert.equal(readModeStamp(live.file), "live");
    assert.equal(readModeStamp(mock.file), "mock");
  } finally {
    rmSync(live.dir, { recursive: true, force: true });
    rmSync(mock.dir, { recursive: true, force: true });
  }
});

test("readModeStamp: any other content is a corrupt stamp, not a silent fallback", () => {
  const { dir, file } = tmpStampFile("production");
  try {
    assert.throws(() => readModeStamp(file), /corrupt mode stamp/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("assertModeStamp: stamp absent is a no-op regardless of runtime env (checkout serves untouched)", () => {
  assert.doesNotThrow(() => assertModeStamp(undefined, {}));
  assert.doesNotThrow(() => assertModeStamp(undefined, { OBSTACK_DATA_MODE: "mock" }));
  assert.doesNotThrow(() => assertModeStamp(undefined, { OBSTACK_DATA_MODE: "live" }));
});

test("assertModeStamp: stamp present, runtime mode unset — refuses, naming the stamped value", () => {
  assert.throws(() => assertModeStamp("live", {}), /OBSTACK_DATA_MODE=live baked in.*unset/);
  assert.throws(() => assertModeStamp("mock", {}), /OBSTACK_DATA_MODE=mock baked in.*unset/);
});

test("assertModeStamp: stamp and runtime disagree — refuses, naming both values", () => {
  assert.throws(
    () => assertModeStamp("mock", { OBSTACK_DATA_MODE: "live" }),
    /OBSTACK_DATA_MODE=mock baked in.*running with OBSTACK_DATA_MODE=live/,
  );
  assert.throws(
    () => assertModeStamp("live", { OBSTACK_DATA_MODE: "mock" }),
    /OBSTACK_DATA_MODE=live baked in.*running with OBSTACK_DATA_MODE=mock/,
  );
});

test("assertModeStamp: live-stamped with no secret — refuses with the generate instruction", () => {
  assert.throws(
    () => assertModeStamp("live", { OBSTACK_DATA_MODE: "live" }),
    /BETTER_AUTH_SECRET.*openssl rand -base64 32/,
  );
  assert.throws(
    () => assertModeStamp("live", { OBSTACK_DATA_MODE: "live", BETTER_AUTH_SECRET: "" }),
    /openssl rand -base64 32/,
  );
});

test("assertModeStamp: matched live stamp with a secret set — green", () => {
  assert.doesNotThrow(() =>
    assertModeStamp("live", { OBSTACK_DATA_MODE: "live", BETTER_AUTH_SECRET: "s3cr3t" }),
  );
});

test("assertModeStamp: matched mock stamp needs no secret at all — green (D262)", () => {
  assert.doesNotThrow(() => assertModeStamp("mock", { OBSTACK_DATA_MODE: "mock" }));
});

test("assertModeStamp: mock-stamped with a real billing rail — refuses, naming both values (D353)", () => {
  // Mock mode never reaches `getBilling()`, so the same refusal placed in the
  // billing module would be a guard on a path this artifact does not run —
  // it would boot, serve the demo, and quietly present a billing rail nobody
  // can reach. Boot is the only honest place for it, and it is env-only here
  // precisely because importing `billing/` would breach D110.
  assert.throws(
    () => assertModeStamp("mock", { OBSTACK_DATA_MODE: "mock", OBSTACK_BILLING_MODE: "polar" }),
    /OBSTACK_DATA_MODE=mock baked in.*running with OBSTACK_BILLING_MODE=polar/,
  );
  assert.throws(
    () =>
      assertModeStamp("mock", {
        OBSTACK_DATA_MODE: "mock",
        OBSTACK_BILLING_MODE: "polar-sandbox",
      }),
    /OBSTACK_DATA_MODE=mock baked in.*running with OBSTACK_BILLING_MODE=polar-sandbox/,
  );
});

test("assertModeStamp: mock-stamped with the fake rail, or none, is green (D353)", () => {
  // Unset IS fake — `billingMode()` defaults to it (D168) — so an unset
  // variable is the demo's own configuration, not something forgotten.
  assert.doesNotThrow(() => assertModeStamp("mock", { OBSTACK_DATA_MODE: "mock" }));
  assert.doesNotThrow(() =>
    assertModeStamp("mock", { OBSTACK_DATA_MODE: "mock", OBSTACK_BILLING_MODE: "fake" }),
  );
});

test("assertModeStamp: a live artifact on any rail is green — the inverse is NOT refused (D353)", () => {
  // live + fake is a real configuration: compose and the chart run it, and a
  // self-hosted deployment that never bills stays on it forever.
  const live = { OBSTACK_DATA_MODE: "live", BETTER_AUTH_SECRET: "s3cr3t" };
  assert.doesNotThrow(() => assertModeStamp("live", live));
  assert.doesNotThrow(() => assertModeStamp("live", { ...live, OBSTACK_BILLING_MODE: "polar" }));
});

test("checkModeStampOnBoot: wires readModeStamp into assertModeStamp against the real STAMP_PATH (green path)", () => {
  // `STAMP_PATH` is fixed at module-import time from `process.cwd()`
  // (mirroring `server.js`'s own `process.chdir(__dirname)` before the boot
  // check ever runs), so this test writes to the real, already-resolved
  // path rather than chdir'ing — the checkout never has a file there, so
  // this is additive, not a mutation of anything real.
  //
  // Only the GREEN case is exercised here on purpose: on refusal,
  // `checkModeStampOnBoot` calls `process.exit(1)` (see its own doc comment
  // for why a throw alone is not enough against this Next version's
  // runtime), which would take the test runner down with it. The refusal
  // path is proven by `docker run` against a live container instead — T1's
  // done-check's red-then-green matrix, not a unit test.
  writeFileSync(STAMP_PATH, "mock");
  const before = process.env.OBSTACK_DATA_MODE;
  const beforeBilling = process.env.OBSTACK_BILLING_MODE;
  process.env.OBSTACK_DATA_MODE = "mock";
  // This one call reads the REAL environment, so a shell that happens to
  // export a Polar mode would make the boot check exit(1) and take the runner
  // with it — the D353 refusal is asserted above, against an env literal.
  delete process.env.OBSTACK_BILLING_MODE;
  try {
    assert.doesNotThrow(() => checkModeStampOnBoot());
  } finally {
    rmSync(STAMP_PATH, { force: true });
    if (before === undefined) delete process.env.OBSTACK_DATA_MODE;
    else process.env.OBSTACK_DATA_MODE = before;
    if (beforeBilling !== undefined) process.env.OBSTACK_BILLING_MODE = beforeBilling;
  }
});
