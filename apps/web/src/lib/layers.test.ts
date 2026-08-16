import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { layerOrder } from "./layers";

// run with: npm test — whose glob is src/**/*.test.ts, so this guard has to sit
// under src/ to run at all

// The layer vocabulary is declared once per language and reconciled by nothing:
// ClickHouse holds it as an Enum8, the ingest classifier as Go constants, the web
// app as a TypeScript union. The drift this file exists to catch is Go emitting a
// layer the Enum8 does not list — ClickHouse rejects the whole INSERT, so it lands
// as dropped production telemetry rather than a failed build. TS/SQL drift is
// cheaper but still silent: the adapter folds anything it does not recognise into
// "other" (D22), so the span arrives mislabelled instead of erroring.
//
// Every list below is parsed out of its own source at test time. Restating the
// layers here would make this file a fourth copy to keep in sync — the exact
// failure it is supposed to prevent.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

const source = (relative: string): string => {
  const file = path.join(repoRoot, relative);
  try {
    return readFileSync(file, "utf8");
  } catch (cause) {
    throw new Error(`layer contract: cannot read ${relative} (looked in ${file})`, { cause });
  }
};

// Comments are stripped before anything is matched, because all three sources
// discuss the layer names in prose right above the declaration — 0001_spans.sql:19
// quotes 'other', types.ts:1 quotes "other", mapping.go's package doc spells out
// the whole classification table. A scanner that harvests quoted words would pick
// up those phantoms and then cheerfully agree with itself. Quote state is tracked
// so a marker inside a string literal is left alone, the same way the project's
// own migrate.SplitStatements does it.
const stripLineComments = (text: string, marker: string, quote: string): string => {
  let out = "";
  let open = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (open) {
      out += ch;
      if (ch === "\\") out += text[++i] ?? "";
      else if (ch === open) open = "";
      continue;
    }
    if (ch === quote) {
      open = ch;
      out += ch;
      continue;
    }
    if (text.startsWith(marker, i)) {
      const eol = text.indexOf("\n", i);
      if (eol === -1) break;
      out += "\n";
      i = eol;
      continue;
    }
    out += ch;
  }
  return out;
};

const ENUM8_SQL = "services/ingest/migrations/0001_spans.sql";
const MAPPING_GO = "services/ingest/internal/mapping/mapping.go";
const TYPES_TS = "apps/web/src/lib/types.ts";
const ADAPTERS_TS = "apps/web/src/server/adapters.ts";

// Reads the `layer` Enum8 as name -> ordinal. 0001_spans.sql declares three Enum8
// columns and `kind` comes first, so this anchors on the column name rather than on
// the first Enum8 it sees; the body is read to its matching paren rather than to
// end of line, so reflowing the declaration across lines still parses instead of
// silently returning one member.
const readEnum8 = (): Map<string, number> => {
  const sql = stripLineComments(source(ENUM8_SQL), "--", "'");
  const open = /^[ \t]*layer[ \t]+Enum8[ \t]*\(/m.exec(sql);
  if (!open) {
    throw new Error(
      `layer contract: no \`layer Enum8(\` column in ${ENUM8_SQL} — the declaration moved or was reformatted, and this test will not pass by comparing a vocabulary it never found`,
    );
  }
  const body = sql.slice(open.index + open[0].length);
  let end = -1;
  for (let i = 0, quoted = false; i < body.length; i++) {
    if (quoted) {
      if (body[i] === "\\") i++;
      else if (body[i] === "'") quoted = false;
    } else if (body[i] === "'") quoted = true;
    else if (body[i] === ")") {
      end = i;
      break;
    }
  }
  if (end === -1) {
    throw new Error(`layer contract: the layer Enum8 in ${ENUM8_SQL} is never closed — unbalanced parens or an unterminated quote`);
  }
  const members = new Map<string, number>();
  for (const [, name, code] of body.slice(0, end).matchAll(/'((?:[^'\\]|\\.)*)'\s*=\s*(-?\d+)/g)) {
    members.set(name, Number(code));
  }
  if (members.size === 0) {
    throw new Error(`layer contract: found the layer Enum8 in ${ENUM8_SQL} but no \`'name' = N\` members inside it`);
  }
  return members;
};

// Reads the Layer* constants as suffix -> value. Value is taken from the literal,
// never derived from the identifier: LayerAPI is "api", not "a_p_i".
const readGoConstants = (): Map<string, string> => {
  const go = stripLineComments(source(MAPPING_GO), "//", '"');
  const constants = new Map<string, string>();
  for (const [, name, value] of go.matchAll(/\bLayer([A-Za-z0-9]+)\s*=\s*"((?:[^"\\]|\\.)*)"/g)) {
    constants.set(name, value);
  }
  if (constants.size === 0) {
    throw new Error(
      `layer contract: no \`Layer… = "…"\` constants in ${MAPPING_GO} — the const block moved, was renamed, or grew an explicit type, and an empty Go vocabulary trivially satisfies every check below`,
    );
  }
  return constants;
};

// Reads the members of a string-literal union or array. Anchored strictly to the
// text between the `=` and the terminating `;` or `]`: types.ts holds four other
// literal unions, and the JSDoc directly above Layer contains the token "other",
// which a file-wide scan would harvest as a phantom member — invisibly, for as long
// as "other" happens to be a real member.
const readLiterals = (relative: string, anchor: RegExp, what: string): Set<string> => {
  const match = anchor.exec(source(relative));
  if (!match) {
    throw new Error(
      `layer contract: no ${what} in ${relative} — it was renamed or reformatted past this pattern, and a vocabulary parsed as empty would make this whole file pass vacuously`,
    );
  }
  const body = match[1].replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  const members = new Set([...body.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]));
  if (members.size === 0) {
    throw new Error(`layer contract: found ${what} in ${relative} but no quoted members in it`);
  }
  return members;
};

const enum8 = readEnum8();
const goConstants = readGoConstants();
const union = readLiterals(TYPES_TS, /export\s+type\s+Layer\s*=([^;]*);/, "`export type Layer` union");
const adapterLayers = readLiterals(ADAPTERS_TS, /const\s+LAYERS\s*:[^=]*=\s*\[([^\]]*)\]/, "`const LAYERS` array");

// The only hardcoded list in this file, and pinned on purpose. Everything else is
// parsed because a second copy is a second thing to forget — but an Enum8 stores
// the ORDINAL on disk, not the name, so moving 'agent' from 2 to 3 silently
// relabels every span already written. That is a data migration wearing a rename's
// clothes, and it should cost whoever does it a deliberate edit here. Appending a
// new layer at a fresh ordinal is safe and needs no change below.
const FROZEN_ORDINALS: Readonly<Record<string, number>> = Object.freeze({
  other: 0,
  api: 1,
  agent: 2,
  tool: 3,
  llm: 4,
  infra: 5,
});

test("every layer source still parses into a non-empty vocabulary", () => {
  // The extractors throw on a miss, so reaching this line already proves all four
  // files parsed. The sizes are asserted anyway: a contract test that compares two
  // empty sets passes forever while the thing it guards rots, and that failure mode
  // is worse than having no test, so it gets its own assertion rather than being
  // left as a property of the parsers.
  assert.ok(enum8.size > 0, `${ENUM8_SQL}: layer Enum8 parsed to nothing`);
  assert.ok(goConstants.size > 0, `${MAPPING_GO}: Layer constants parsed to nothing`);
  assert.ok(union.size > 0, `${TYPES_TS}: Layer union parsed to nothing`);
  assert.ok(adapterLayers.size > 0, `${ADAPTERS_TS}: LAYERS parsed to nothing`);
});

test("the Enum8 ordinals already written to disk have not moved", () => {
  for (const [name, code] of Object.entries(FROZEN_ORDINALS)) {
    const actual = enum8.get(name);
    assert.notEqual(
      actual,
      undefined,
      `${ENUM8_SQL} no longer declares layer '${name}' (was = ${code}); every span already stored as ordinal ${code} would decode as whatever now holds that number`,
    );
    assert.equal(
      actual,
      code,
      `${ENUM8_SQL} renumbered layer '${name}' from ${code} to ${actual}; ClickHouse stores the ordinal, so every span already written as '${name}' now reads back as a different layer. If this is intended, it is a data migration — change the number here only alongside one.`,
    );
  }
  const collisions = [...enum8]
    .filter(([name, code]) => [...enum8].some(([other, otherCode]) => other !== name && otherCode === code))
    .map(([name, code]) => `'${name}' = ${code}`);
  assert.deepEqual(
    collisions,
    [],
    `${ENUM8_SQL} gives two layers the same Enum8 ordinal (${collisions.join(", ")}); a new layer has to take a fresh number, never a retired one`,
  );
});

test("every layer the Go classifier can emit exists in the Enum8", () => {
  // Deliberately one-way. 'infra' is in the Enum8 and reserved for the M2 collector
  // spans (mapping.go's package doc), so Go is expected to be a strict subset: a
  // layer the classifier never emits costs nothing. A layer it emits that ClickHouse
  // has never heard of costs the entire INSERT batch, in production, at runtime.
  const unstorable = [...goConstants]
    .filter(([, value]) => !enum8.has(value))
    .map(([name, value]) => `mapping.Layer${name} = "${value}"`);
  assert.deepEqual(
    unstorable,
    [],
    `${MAPPING_GO} can emit ${unstorable.join(", ")}, which the layer Enum8 in ${ENUM8_SQL} does not list; ClickHouse rejects the whole INSERT on an unknown enum value, so this drops spans in production rather than failing a build. Add the value to the Enum8 first.`,
  );
});

test("the Enum8 and the TypeScript Layer union describe the same vocabulary", () => {
  const sqlOnly = [...enum8.keys()].filter((layer) => !union.has(layer));
  const tsOnly = [...union].filter((layer) => !enum8.has(layer));
  assert.deepEqual(
    sqlOnly,
    [],
    `${ENUM8_SQL} can store ${sqlOnly.map((l) => `'${l}'`).join(", ")}, which the Layer union in ${TYPES_TS} does not name; toLayer() folds unrecognised values into "other", so those spans reach the UI mislabelled instead of erroring`,
  );
  assert.deepEqual(
    tsOnly,
    [],
    `the Layer union in ${TYPES_TS} names ${tsOnly.map((l) => `"${l}"`).join(", ")}, which the Enum8 in ${ENUM8_SQL} cannot store; the UI is typed for a layer no row can ever carry`,
  );
});

test("the adapter's runtime layer list matches the union it casts to", () => {
  // LAYERS is `readonly string[]` rather than `readonly Layer[]` because
  // .includes(value: string) needs the wider element type — so tsc checks nothing
  // about its contents, while it is the only runtime guard in front of an
  // `as Layer` cast. A member missing from it becomes "other", and for an llm span
  // that also drops model, tokens, cost, prompt and completion.
  const unlisted = [...union].filter((layer) => !adapterLayers.has(layer));
  const stale = [...adapterLayers].filter((layer) => !union.has(layer));
  assert.deepEqual(
    unlisted,
    [],
    `LAYERS in ${ADAPTERS_TS} is missing ${unlisted.map((l) => `"${l}"`).join(", ")} from the Layer union; toLayer() will silently rewrite those spans to "other"`,
  );
  assert.deepEqual(
    stale,
    [],
    `LAYERS in ${ADAPTERS_TS} lists ${stale.map((l) => `"${l}"`).join(", ")}, which is not in the Layer union; the membership test would pass it straight through the \`as Layer\` cast unsoundly`,
  );
});

test("layerOrder lists every layer exactly once", () => {
  // layerColor and layerLabel are Record<Layer, string>, which tsc closes in both
  // directions (missing key TS2741, extra key TS2353), so they are not re-checked
  // here. Layer[] closes neither: a missing member is legal TypeScript that just
  // drops the layer from the explore filters, the wordmark and the ask header, and
  // a duplicate renders it twice. That is the gap the compiler leaves.
  const ordered: readonly string[] = layerOrder;
  const dropped = [...union].filter((layer) => !ordered.includes(layer));
  assert.deepEqual(
    dropped,
    [],
    `layerOrder is missing ${dropped.map((l) => `"${l}"`).join(", ")} from the Layer union; tsc accepts a short Layer[], so the layer would simply stop appearing in every UI that renders layerOrder`,
  );
  const duplicated = ordered.filter((layer, i) => ordered.indexOf(layer) !== i);
  assert.deepEqual(duplicated, [], `layerOrder repeats ${duplicated.map((l) => `"${l}"`).join(", ")}; every surface driven by it renders that layer twice`);
});
