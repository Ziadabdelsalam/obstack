import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  INCIDENT_ORIGINS,
  INCIDENT_SEVERITIES,
  INCIDENT_STATUSES,
  INCIDENT_TIMELINE_KINDS,
  formatIncidentClock,
  formatIncidentDuration,
  formatIncidentWindow,
} from "./incident-types";

// run with: npm test --workspace apps/web
//          (one file: cd apps/web && npx tsx --conditions react-server --test src/lib/incident-types.test.ts)
//
// D525/D541: the three stored vocabularies exist in two places — the DDL's
// CHECK clauses, which are the authority, and this module's unions with their
// runtime lists. This file is the ONE test that pins them to each other, in the
// `change-types.test.ts` cross-source idiom (D385/D499): read the OTHER side's
// REAL declaration and compare; never restate a value here, which would make
// this file a third place to update and pin nothing.
//
// The path: this file is `apps/web/src/lib/`, so four levels up is the repo root.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../../..");
const DDL = path.join(REPO_ROOT, "services/ingest/pgmigrations/0013_incidents.sql");

/** The DDL with every `--` comment line removed, so a sentence in the file's
 *  82-line prose header can never be what a vocabulary is parsed out of. */
const ddlSource = readFileSync(DDL, "utf8")
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");

/**
 * The members of one column's `CHECK (<column> IN ('a', 'b'))`, in DDL order.
 *
 * Deliberately specific: it must match the COLUMN DEFINITION line
 * (`<indent><column> TEXT … CHECK (<column> IN (…))`), so a table-level CHECK or
 * a stray mention cannot answer for it. Both the match and the member set are
 * asserted non-empty before anything is compared — a regex that quietly stops
 * matching would otherwise turn this whole file into a vacuous pass.
 */
function ddlCheckVocabulary(column: string): string[] {
  const pattern = new RegExp(`^\\s+${column}\\s+TEXT\\b[^\\n]*?CHECK \\(${column} IN \\(([^)]*)\\)\\)`, "m");
  const match = ddlSource.match(pattern);
  assert.ok(
    match,
    `0013_incidents.sql has no \`${column} TEXT … CHECK (${column} IN (…))\` column definition — the DDL moved; fix this regex, never restate the values here`,
  );
  const members = [...match![1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
  assert.ok(members.length > 0, `parsed an EMPTY vocabulary for ${column}: a parse failure must not pass vacuously`);
  return members;
}

test("D525: the three vocabularies are the DDL's, parsed out of 0013_incidents.sql and never restated", () => {
  // Non-vacuity first: prove we are reading the incidents DDL at all, and that
  // it still declares the three columns this contract types.
  assert.match(ddlSource, /CREATE TABLE IF NOT EXISTS incidents\b/, "0013_incidents.sql no longer creates `incidents`");
  assert.equal(ddlCheckVocabulary("status").length, 2, "the status CHECK is not two members");
  assert.equal(ddlCheckVocabulary("severity").length, 3, "the severity CHECK is not three members");
  assert.equal(ddlCheckVocabulary("origin").length, 2, "the origin CHECK is not two members");

  assert.deepEqual([...INCIDENT_STATUSES], ddlCheckVocabulary("status"), "INCIDENT_STATUSES has drifted from the DDL's status CHECK");
  assert.deepEqual([...INCIDENT_ORIGINS], ddlCheckVocabulary("origin"), "INCIDENT_ORIGINS has drifted from the DDL's origin CHECK");

  // D525's whole point: severity is the ALERT vocabulary VERBATIM, three
  // members including `info`, because promotion copies an alert_events.severity
  // and a narrower target forces a mapping that overstates an info event or
  // understates a critical one. So it is pinned to BOTH DDLs — this table's
  // CHECK and the one it copies from — and the mock's two-member union
  // (critical|warning) reds this test.
  const severityHere = ddlCheckVocabulary("severity");
  assert.deepEqual([...INCIDENT_SEVERITIES], severityHere, "INCIDENT_SEVERITIES has drifted from the DDL's severity CHECK");

  const alertsDdl = readFileSync(path.join(REPO_ROOT, "services/ingest/pgmigrations/0010_alerts.sql"), "utf8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
  // 0010 declares severity TWICE — alert_rules and alert_events — so a
  // non-global match would pin the FIRST (alert_rules) while D525 names
  // alert_events as the authority: promotion copies an alert_events row. Both
  // are captured and both must agree with ours, so the assertion cannot go on
  // passing against one table while the other widens underneath it.
  const alertMatches = [...alertsDdl.matchAll(/^\s+severity\s+TEXT\b[^\n]*?CHECK \(severity IN \(([^)]*)\)\)/gm)];
  assert.equal(alertMatches.length, 2, "0010_alerts.sql no longer declares severity on exactly alert_rules and alert_events — re-anchor this pin");
  for (const alertMatch of alertMatches) {
    const alertSeverities = [...alertMatch[1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
    assert.ok(alertSeverities.length > 0, "parsed an EMPTY alert severity vocabulary: a parse failure must not pass vacuously");
    assert.deepEqual(severityHere, alertSeverities, "incidents.severity is no longer the alert vocabulary verbatim (D525)");
  }
});

test("D537: four timeline kinds, and the four the mock had that no live leg can emit are gone", () => {
  // Three READ legs (D530) plus `resolved`, which is synthesized from the
  // incident's own ended_at column. An enum member no leg can emit is D13 in
  // type form, which is what this deep-equal exists to stop.
  assert.deepEqual([...INCIDENT_TIMELINE_KINDS], ["alert", "change", "trace", "resolved"]);

  // The four that die, each with the reason it dies — asserted by name so a
  // future edit that reintroduces one has to argue with this list:
  //  - `k8s`     — the S4.4 R3 COPY FENCE. Cluster events ARE ingested
  //                (`server/adapters.ts:18-20`), so the reason is not "nothing
  //                ingests it": it is the fence, plus the fact that the only
  //                read that exists is per-trace and pod-scoped rather than a
  //                per-window workspace enumeration.
  //  - `metric`  — D533, the metrics leg is out; metric evidence reaches the
  //                timeline as alert events measured against a threshold
  //                somebody set.
  //  - `pipeline`— no ingest path, and /app/pipelines is unwired.
  //  - `action`  — no operator-action store; the mock's operator row IS a
  //                change event.
  for (const dead of ["k8s", "metric", "pipeline", "action"]) {
    assert.ok(
      !(INCIDENT_TIMELINE_KINDS as readonly string[]).includes(dead),
      `${dead} is back in INCIDENT_TIMELINE_KINDS and no leg emits it (D537; k8s is out on the S4.4 R3 copy fence, metric on D533)`,
    );
  }
});

// ---- the formatters. Every expected string below is COMPUTED from the
// arithmetic of the input that produced it — the input is built from named
// component counts and the expectation is rendered from those SAME counts, so a
// pass means the formatter's own floor chain agrees with the decomposition it
// was handed, not that someone typed the answer they saw.

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const START_ISO = "2026-09-04T13:04:00.000Z";
const START = Date.parse(START_ISO);
const iso = (ms: number) => new Date(ms).toISOString();
/** The `nowMs` a RESOLVED incident is rendered against: it must not be read at
 *  all when `endedAt` is present, so it is deliberately absurd. */
const IRRELEVANT_NOW = Date.parse("1999-01-01T00:00:00.000Z");

test("formatIncidentDuration floors into the two units that carry information", () => {
  // under a minute: 59.999s floors to ZERO minutes, and `${0}m` would print
  // "0m" — a real 59-second outage rendered as a zero-length one.
  const almost = MINUTE - 1;
  assert.equal(formatIncidentDuration(START_ISO, iso(START + almost), IRRELEVANT_NOW), "under a minute");
  assert.notEqual(formatIncidentDuration(START_ISO, iso(START + almost), IRRELEVANT_NOW), `${Math.floor(almost / MINUTE)}m`);

  // exactly 60s: the first instant the minutes bucket can state a number.
  const oneMinute = 60 * SECOND;
  assert.equal(formatIncidentDuration(START_ISO, iso(START + oneMinute), IRRELEVANT_NOW), `${oneMinute / MINUTE}m`);

  // the mock's own 22-minute window, computed from its two instants rather than
  // from the fixture's "22m" display string.
  const mockMs = Date.parse("2026-09-04T13:26:00.000Z") - Date.parse("2026-09-04T13:04:00.000Z");
  assert.equal(
    formatIncidentDuration("2026-09-04T13:04:00.000Z", "2026-09-04T13:26:00.000Z", IRRELEVANT_NOW),
    `${mockMs / MINUTE}m`,
  );

  // 1h 12m — built from its own components, and with 59s of remainder to prove
  // the floor: seconds never round a bucket up.
  const h = 1;
  const m = 12;
  assert.equal(formatIncidentDuration(START_ISO, iso(START + h * HOUR + m * MINUTE), IRRELEVANT_NOW), `${h}h ${m}m`);
  assert.equal(
    formatIncidentDuration(START_ISO, iso(START + h * HOUR + m * MINUTE + 59 * SECOND), IRRELEVANT_NOW),
    `${h}h ${m}m`,
  );

  // the hour boundary in both directions: 59m stays minutes, 60m becomes hours.
  assert.equal(formatIncidentDuration(START_ISO, iso(START + 59 * MINUTE), IRRELEVANT_NOW), `${59}m`);
  const carryM = 60;
  assert.equal(
    formatIncidentDuration(START_ISO, iso(START + carryM * MINUTE), IRRELEVANT_NOW),
    `${Math.floor(carryM / 60)}h ${carryM % 60}m`,
  );

  // 2d 3h — same construction, plus 59m 59s of remainder that must NOT appear.
  const d = 2;
  const dh = 3;
  assert.equal(formatIncidentDuration(START_ISO, iso(START + d * DAY + dh * HOUR), IRRELEVANT_NOW), `${d}d ${dh}h`);
  assert.equal(
    formatIncidentDuration(START_ISO, iso(START + d * DAY + dh * HOUR + 59 * MINUTE + 59 * SECOND), IRRELEVANT_NOW),
    `${d}d ${dh}h`,
  );

  // the day boundary: 23h stays hours, 24h becomes days.
  const topH = 23;
  assert.equal(
    formatIncidentDuration(START_ISO, iso(START + topH * HOUR), IRRELEVANT_NOW),
    `${topH % 24}h ${0 % 60}m`,
  );
  const carryH = 24;
  assert.equal(
    formatIncidentDuration(START_ISO, iso(START + carryH * HOUR), IRRELEVANT_NOW),
    `${Math.floor(carryH / 24)}d ${carryH % 24}h`,
  );
});

test("formatIncidentDuration clamps at zero — a negative interval renders neither a minus nor a wrong bucket", () => {
  const zero = formatIncidentDuration(START_ISO, START_ISO, IRRELEVANT_NOW);
  assert.equal(zero, "under a minute");

  // An ongoing incident is measured against a clock the CALLER supplies, so an
  // incident whose started_at sits a little ahead of that clock is ordinary
  // skew, not a reason to render "-1m". Every negative interval collapses onto
  // the zero answer.
  for (const backwards of [1 * SECOND, 90 * SECOND, 2 * DAY + 3 * HOUR]) {
    const rendered = formatIncidentDuration(START_ISO, iso(START - backwards), IRRELEVANT_NOW);
    assert.equal(rendered, zero, `an interval of -${backwards}ms did not clamp onto the zero answer`);
    assert.doesNotMatch(rendered, /-/, "a duration must never render a minus sign");
  }

  // The falsifier the clamp exists for: unclamped, -(2d 3h) would floor into
  // the DAYS bucket and print a confident "-2d -3h" — a wrong bucket, not just
  // a wrong sign.
  const bigBackwards = formatIncidentDuration(START_ISO, iso(START - (2 * DAY + 3 * HOUR)), IRRELEVANT_NOW);
  assert.doesNotMatch(bigBackwards, /d /, "a negative interval must not reach the days bucket at all");

  // Same clamp on the ongoing path, where the skew actually happens: nowMs
  // BEHIND started_at.
  assert.equal(formatIncidentDuration(START_ISO, null, START - 30 * SECOND), zero);
  assert.equal(formatIncidentDuration(START_ISO, null, START - 5 * DAY), zero);
});

test("formatIncidentWindow: a resolved window states its date once, the end only if it is the same day", () => {
  // Expected parts derived from the ISO instants themselves — a different
  // derivation from the formatter's getUTC* path, so agreement means both are
  // right rather than that one copies the other.
  const endMs = START + 22 * MINUTE;
  const endIso = iso(endMs);
  const day = START_ISO.slice(0, 10);
  const startHm = START_ISO.slice(11, 16);
  const endHm = endIso.slice(11, 16);
  assert.equal(endIso.slice(0, 10), day, "this case is only about a window INSIDE one UTC day");

  assert.equal(
    formatIncidentWindow(START_ISO, endIso, IRRELEVANT_NOW),
    `${day} ${startHm} → ${endHm} UTC · ${(endMs - START) / MINUTE}m`,
  );

  // `nowMs` is not consulted on a resolved incident: the same call against a
  // wildly different clock renders the same string.
  assert.equal(
    formatIncidentWindow(START_ISO, endIso, Date.now()),
    formatIncidentWindow(START_ISO, endIso, IRRELEVANT_NOW),
  );
});

test("formatIncidentWindow: a window over midnight prints the end's FULL date, so it cannot read as going backwards", () => {
  // 23:50 → 00:12 the next day. Without the date on the end this renders
  // "23:50 → 00:12", which reads as a window that ends before it starts.
  const startIso = "2026-09-04T23:50:00.000Z";
  const startMs = Date.parse(startIso);
  const minutes = 22;
  const endIso = iso(startMs + minutes * MINUTE);

  const startDay = startIso.slice(0, 10);
  const endDay = endIso.slice(0, 10);
  const startHm = startIso.slice(11, 16);
  const endHm = endIso.slice(11, 16);
  assert.notEqual(endDay, startDay, "this case is only meaningful if the window actually crosses a UTC date");

  const rendered = formatIncidentWindow(startIso, endIso, IRRELEVANT_NOW);
  assert.equal(rendered, `${startDay} ${startHm} → ${endDay} ${endHm} UTC · ${minutes}m`);

  // The defect this exists to catch, stated as its own assertion: the time-only
  // end form must not appear anywhere in the output.
  assert.ok(!rendered.includes(`${startHm} → ${endHm} UTC`), "the end printed as a bare time across a date boundary");
  assert.ok(rendered.includes(endDay), "the end's own date is missing");

  // And the converse, so the rule is not "always print the date": a 23-hour
  // window that stays inside one UTC day prints the end as a bare time, while a
  // four-minute one at 23:58 does not.
  const sameDay = formatIncidentWindow("2026-09-04T00:30:00.000Z", "2026-09-04T23:30:00.000Z", IRRELEVANT_NOW);
  const sameDayMins = (Date.parse("2026-09-04T23:30:00.000Z") - Date.parse("2026-09-04T00:30:00.000Z")) / MINUTE;
  assert.equal(
    sameDay,
    `2026-09-04 00:30 → 23:30 UTC · ${Math.floor(sameDayMins / 60)}h ${sameDayMins % 60}m`,
  );
  const acrossFour = formatIncidentWindow("2026-09-04T23:58:00.000Z", "2026-09-05T00:02:00.000Z", IRRELEVANT_NOW);
  const acrossMins = (Date.parse("2026-09-05T00:02:00.000Z") - Date.parse("2026-09-04T23:58:00.000Z")) / MINUTE;
  assert.equal(acrossFour, `2026-09-04 23:58 → 2026-09-05 00:02 UTC · ${acrossMins}m`);
});

test("formatIncidentWindow: an ongoing incident says so, appends `so far`, and takes its clock from the caller", () => {
  const minutes = 22;
  const now = START + minutes * MINUTE;
  const day = START_ISO.slice(0, 10);
  const startHm = START_ISO.slice(11, 16);

  assert.equal(formatIncidentWindow(START_ISO, null, now), `${day} ${startHm} UTC → ongoing · ${minutes}m so far`);

  // The clock is the CALLER's: the same incident against a clock an hour later
  // renders an hour more, and nothing in this module reads a wall clock.
  assert.equal(
    formatIncidentWindow(START_ISO, null, now + HOUR),
    `${day} ${startHm} UTC → ongoing · ${1}h ${minutes}m so far`,
  );

  // `nowMs` is REQUIRED and defaultless on both formatters that take it — the
  // `lib/format.ts:45-57` timeAgo discipline. Function.prototype.length counts
  // parameters up to the FIRST defaulted one, so a `= Date.now()` default drops
  // these from 3 to 2. This is the deterministic half of the pin.
  assert.equal(formatIncidentWindow.length, 3, "formatIncidentWindow's nowMs must be REQUIRED and defaultless");
  assert.equal(formatIncidentDuration.length, 3, "formatIncidentDuration's nowMs must be REQUIRED and defaultless");
  // D568: §0's "nowMs REQUIRED on the three formatters" binds the two that
  // take a clock. formatIncidentClock renders an ABSOLUTE instant, so a nowMs
  // it never reads would be a discipline that pins nothing — its arity is
  // asserted at ONE so a later editor cannot add a defaulted clock to it.
  assert.equal(formatIncidentClock.length, 1, "formatIncidentClock renders an absolute instant and must take only it (D568)");

  // And the behavioural half, which says WHY: with the argument withheld (tsc
  // refuses the call outright, hence the loosened binding), a defaultless
  // formatter cannot answer at all, while a defaulted one silently answers from
  // the wall clock — the D64 lie, an ongoing incident aged against whatever
  // clock happened to be nearest instead of the request's own.
  const withheld = formatIncidentWindow as unknown as (a: string, b: string | null) => string;
  assert.notEqual(
    withheld(START_ISO, null),
    formatIncidentWindow(START_ISO, null, Date.now()),
    "formatIncidentWindow answered from the wall clock when nowMs was withheld",
  );
  // The notEqual above is only worth something if the withheld side is HONEST
  // rather than merely different: before the NO_INSTANT guard it differed by
  // rendering `NaNd NaNh`, so the assertion passed because one side was
  // garbage and never said the answer was not. These two say it.
  assert.doesNotMatch(withheld(START_ISO, null), /NaN/, "a withheld clock rendered NaN into product copy");
  assert.match(withheld(START_ISO, null), /—/, "a withheld clock must render the absent instant, not a number");
});

test("D13: an instant the product cannot read renders as absent, never as a number and never as a fabricated one", () => {
  // `Math.max(0, NaN)` is NaN and NaN fails every `<`, so without the guard an
  // unparseable instant falls through the unit ladder into the days bucket.
  assert.equal(formatIncidentDuration("not-an-iso", iso(START + 22 * MINUTE), 0), "—");
  assert.equal(formatIncidentDuration(START_ISO, "not-an-iso", 0), "—");
  assert.equal(formatIncidentDuration(START_ISO, null, Number.NaN), "—");
  assert.equal(formatIncidentWindow("not-an-iso", iso(START + 22 * MINUTE), 0), "—");
  assert.equal(formatIncidentWindow(START_ISO, "not-an-iso", 0), "—");
  assert.equal(formatIncidentClock("not-an-iso"), "—");
  // The one that matters most is NOT the NaN case — NaN at least looks broken.
  // `new Date(null)` is the EPOCH, so an absent instant would otherwise render
  // `1970-01-01 00:00:00 UTC`: a fully plausible timestamp no reader could
  // tell from a real one. That is the D13 failure this guard exists for.
  assert.equal(formatIncidentClock(null as unknown as string), "—");
  assert.notEqual(formatIncidentClock(null as unknown as string), "1970-01-01 00:00:00 UTC");
});

test("formatIncidentClock keeps the seconds, and reads the instant rather than slicing the string", () => {
  // The mock fixture's two same-minute rows (mock/incident.ts:53,60): a rail
  // that dropped seconds would render both as 13:05 and state that they
  // happened at once.
  const first = "2026-09-04T13:05:02.000Z";
  const second = "2026-09-04T13:05:41.000Z";
  assert.equal(formatIncidentClock(first), `${first.slice(0, 10)} ${first.slice(11, 19)} UTC`);
  assert.equal(formatIncidentClock(second), `${second.slice(0, 10)} ${second.slice(11, 19)} UTC`);
  assert.notEqual(formatIncidentClock(first), formatIncidentClock(second));
  assert.match(formatIncidentClock(first), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC$/);

  // An offset instant is normalised to UTC, not sliced: 2026-09-04T01:04+02:00
  // is 2026-09-03T23:04Z, so a slice-based implementation prints the wrong day
  // AND the wrong hour.
  const offset = "2026-09-04T01:04:52+02:00";
  assert.equal(formatIncidentClock(offset), formatIncidentClock(new Date(offset).toISOString()));
  assert.equal(formatIncidentClock(offset), "2026-09-03 23:04:52 UTC");
});

test("D366/D541: incident-types.ts stays client-safe — no imports at all, and never server-only", () => {
  // The `change-types.test.ts` pin verbatim. It is what makes the module a
  // legal prop type for IncidentsLive/IncidentEditor, which the sprint's import
  // fence bars from `@/server/*` — and `resolvedImports` catches `import type`
  // too, so even a type-only import of a sibling contract would break the
  // surface (D541).
  const source = readFileSync(path.join(HERE, "incident-types.ts"), "utf8");
  assert.equal(/^import /m.test(source), false, "incident-types.ts must carry no imports");
  assert.ok(!/^import ["']server-only["'];?$/m.test(source), "incident-types.ts must never be server-only");
});
