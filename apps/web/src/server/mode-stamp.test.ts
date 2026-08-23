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
  process.env.OBSTACK_DATA_MODE = "mock";
  try {
    assert.doesNotThrow(() => checkModeStampOnBoot());
  } finally {
    rmSync(STAMP_PATH, { force: true });
    if (before === undefined) delete process.env.OBSTACK_DATA_MODE;
    else process.env.OBSTACK_DATA_MODE = before;
  }
});
