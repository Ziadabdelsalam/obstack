import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { NOW } from "@/mock/generate";
import { fmtBytes, fmtCores, fmtCost, fmtPerMin, timeAgo } from "./format";

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

test("fmtPerMin: a real but low rate is never printed as a zero (D13)", () => {
  // Four spans over the 1440-minute window: 0.0028/min. One decimal would
  // render that "0.0" — a service that sent spans, shown as silent.
  assert.equal(fmtPerMin(4 / 1440), "0.003");
  assert.equal(fmtPerMin(0), "0");
  assert.equal(fmtPerMin(0.1), "0.1");
  assert.equal(fmtPerMin(1440 / 1440), "1.0");
  assert.equal(fmtPerMin(12.4), "12");
  // Past 10 the decimals stop carrying information and the separator starts
  // doing the reading: a busy edge on the map is "12,345/min", not "12345".
  assert.equal(fmtPerMin(12_345), "12,345");
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

test("fmtBytes steps the unit, so a container limit reads as the manifest wrote it (D468)", () => {
  // The two limits the kind acceptance asserts on the demo pod (D466): 128Mi +
  // 32Mi of container limits, and their pod-level sum.
  assert.equal(fmtBytes(134_217_728), "128 MiB");
  assert.equal(fmtBytes(33_554_432), "32 MiB");
  assert.equal(fmtBytes(167_772_160), "160 MiB");
  // Under a MiB the unit steps down rather than the number rounding to nothing.
  assert.equal(fmtBytes(921_600), "900 KiB");
  assert.equal(fmtBytes(1024 ** 2), "1 MiB");
  // One decimal starts at GiB: whole GiB would print a 1.7 GiB node and a 2.4
  // GiB one as the same "2 GiB".
  assert.equal(fmtBytes(1024 ** 3), "1.0 GiB");
  assert.equal(fmtBytes(1.7 * 1024 ** 3), "1.7 GiB");
  assert.equal(fmtBytes(2.4 * 1024 ** 3), "2.4 GiB");
  // A measured zero is a zero (the infra surface renders a MISSING metric as
  // "—" before it ever reaches a formatter, D13).
  assert.equal(fmtBytes(0), "0 KiB");
});

test("fmtCores speaks millicores under a core and trims decimals above one (D468)", () => {
  assert.equal(fmtCores(0.55), "550m");
  assert.equal(fmtCores(0.05), "50m");
  assert.equal(fmtCores(0.999), "999m");
  assert.equal(fmtCores(0), "0m");
  assert.equal(fmtCores(1), "1");
  assert.equal(fmtCores(1.5), "1.5");
  assert.equal(fmtCores(2), "2");
  assert.equal(fmtCores(1.234), "1.23");
  assert.equal(fmtCores(3.999), "4");
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
