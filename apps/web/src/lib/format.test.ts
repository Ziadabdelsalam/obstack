import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { NOW } from "@/mock/generate";
import { fmtCost, timeAgo } from "./format";

test("fmtCost never renders a real cost as zero", () => {
  // the smoke trace: a few hundred-thousandths of a dollar
  assert.equal(fmtCost(0.00003), "$0.00003");
  assert.equal(fmtCost(0.000099), "$0.000099");
  assert.equal(fmtCost(0.0000001), "$0.0000001");
  assert.equal(fmtCost(1e-11), "$0.00000000001");
  assert.equal(fmtCost(0), "—");
});

test("fmtCost keeps the established shape for everything 4dp can express", () => {
  assert.equal(fmtCost(0.0001), "$0.0001");
  assert.equal(fmtCost(0.0006), "$0.0006");
  assert.equal(fmtCost(0.0049), "$0.0049");
  assert.equal(fmtCost(0.01), "$0.01");
  assert.equal(fmtCost(81.4), "$81.40");
});

const iso = (ms: number) => new Date(ms).toISOString();

test("timeAgo measures against the clock it is given, and the rendering is unchanged", () => {
  // The mock clock still renders exactly what it rendered when it was baked in
  // (F6/F7): these are the same strings for the same offsets behind `NOW`.
  assert.equal(timeAgo(iso(NOW - 20_000), NOW), "just now");
  assert.equal(timeAgo(iso(NOW - 60_000), NOW), "1m ago");
  assert.equal(timeAgo(iso(NOW - 59 * 60_000), NOW), "59m ago");
  assert.equal(timeAgo(iso(NOW - 90 * 60_000), NOW), "1h 30m ago");
  assert.equal(timeAgo(iso(NOW - 3 * 3_600_000), NOW), "3h 0m ago");
});

test("an ingested row is aged against the request's clock, not the mock one (D64)", () => {
  // A live workspace's rows are stamped now, and the mock clock sits in 2026-08-09.
  const requestMs = Date.parse("2026-11-02T09:15:00.000Z");
  assert.ok(requestMs > NOW, "this fixture only means something ahead of the mock clock");

  const fresh = iso(requestMs - 20_000);
  const aged = iso(requestMs - 2 * 3_600_000);
  assert.equal(timeAgo(fresh, requestMs), "just now");
  assert.equal(timeAgo(aged, requestMs), "2h 0m ago");

  // The measured falsehood, kept as the falsifier: against the mock clock every
  // one of those rows is in the future, the diff is negative, and the floor
  // prints "just now" — so a FRESH row alone cannot catch this. The aged
  // control row is what turns red if the mock clock is ever restored here.
  assert.equal(timeAgo(fresh, NOW), "just now");
  assert.equal(timeAgo(aged, NOW), "just now");
});

/** Every source under `src/`, collected by walking — nothing is listed by hand. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

test("the mock clock stays inside the mock tree and the facade (D64 standing sweep)", () => {
  const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const files = sourceFiles(src);
  assert.ok(files.length > 50, `the sweep read ${files.length} sources — it is not looking at this app`);

  // The import specifier, assembled from parts so this file is not its own hit.
  const importsClock = new RegExp(`from "@/${"mock"}/generate"`);
  const importers = files
    .filter((f) => importsClock.test(readFileSync(f, "utf8")))
    .map((f) => path.relative(src, f));

  // Positive control: the facade really does import it, so an empty result
  // below would be a dead regex rather than an absence (S2.0 L1).
  assert.ok(
    importers.includes("server/data.ts"),
    `the sweep found no importer at all (hits: ${importers.join(", ")})`,
  );

  // Tests build fixtures against the mock clock's own value, which is what a
  // test of mock behaviour has to do; product code may not. Anything else here
  // means `NOW` reached a page, a component or a shared lib again — the D64
  // defect, where one mode's clock silently ages the other mode's rows.
  assert.deepEqual(
    importers.filter((f) => !f.startsWith("mock/") && f !== "server/data.ts" && !/\.test\.tsx?$/.test(f)),
    [],
  );
});
