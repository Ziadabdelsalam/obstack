import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * The package manifest and the README are one claim written twice: npm enforces
 * `peerDependencies`, and a customer reads the coverage table. When the two
 * disagree, the README is what gets believed and npm is what actually happens.
 *
 * D86's shape, so this file is a check and not a third copy: every range is read
 * out of `package.json` at run time and looked for in `README.md`. Nothing here
 * hand-types a version bound — a test that did would go green on a lie as
 * happily as the README does.
 */
const packageJson = JSON.parse(
  readFileSync(path.join(__dirname, "..", "package.json"), "utf8"),
) as { peerDependencies: Record<string, string> };
const readme = readFileSync(path.join(__dirname, "..", "README.md"), "utf8");

test("README carries every peer range this package declares, word for word", () => {
  const declared = Object.entries(packageJson.peerDependencies);
  assert.ok(declared.length > 0, "package.json declares no peers; there is nothing to check");

  const missing = declared
    .map(([name, range]) => `\`${name} ${range}\``)
    .filter((claim) => !readme.includes(claim));

  assert.deepEqual(
    missing,
    [],
    `README.md does not state ${missing.join(", ")}. npm installs the ranges in package.json whatever the README says, so a range that moved without the README moving is a coverage claim about versions this SDK has not measured.`,
  );
});

test("the coverage table names no library this package does not declare", () => {
  // The other direction, and the cheaper mistake: a row for something that is
  // not an optional peer at all reads as a promise npm will not keep.
  // The coverage table only — the README has other tables (init()'s handle, for
  // one), and they are not claims about libraries.
  const heading = "## What is actually covered";
  const start = readme.indexOf(heading);
  assert.notEqual(start, -1, `README.md no longer has a "${heading}" section`);
  const end = readme.indexOf("\n## ", start + heading.length);
  const section = readme.slice(start, end === -1 ? undefined : end);

  const rows = section
    .split("\n")
    .filter((line) => line.startsWith("| `") && line.includes(" | "));
  assert.ok(rows.length >= 4, `only ${rows.length} coverage rows found; the table moved`);

  const declared = new Set(Object.keys(packageJson.peerDependencies));
  // `node:http` / `node:https` are node itself — a hard dependency of the
  // instrumentation, never a peer, and correctly not in the manifest.
  const builtin = /^\| `node:/;

  for (const row of rows) {
    if (builtin.test(row)) continue;
    const name = /^\| `([^`]+)`/.exec(row)?.[1];
    assert.ok(name, `a coverage row does not start with a package name: ${row}`);
    assert.ok(
      declared.has(name),
      `the coverage table has a row for \`${name}\`, which is not in peerDependencies (${[...declared].join(", ")})`,
    );
  }
});
