import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";

// run with: npm test --workspace apps/web
//
// The editor's provable half (S7.4 packet D527, the D179 zone rule): the ONE
// reader of a typed instant, `isoFromField`, exported "so the rule can be
// proven without a browser" — and the T6 fidelity review found nothing proving
// it. Same `require`-seam stubbing as `IncidentRcaPanel.test.tsx`: the editor is
// `"use client"` and imports `next/navigation`, `lucide-react` and its own
// `"use server"` actions module at module scope, none of which this file needs.
const origLoad = (Module as unknown as { _load: (r: string, ...a: unknown[]) => unknown })._load;
(Module as unknown as { _load: (r: string, ...a: unknown[]) => unknown })._load = function (
  request: string,
  ...rest: unknown[]
) {
  if (request === "next/navigation") return { __esModule: true, useRouter: () => null };
  if (request === "lucide-react") return new Proxy({ __esModule: true }, { get: () => () => null });
  if (request === "./actions") return { __esModule: true };
  return origLoad.call(this, request, ...rest);
};

// The trap must be LIVE for the proof to mean anything: a zone-less date-time
// is read by `Date.parse` in the process's local zone (the ES rule), so this
// file pins the process to a zone two hours east of UTC before the module is
// loaded, and checks that it took.
process.env.TZ = "Europe/Berlin";
assert.notEqual(new Date("2026-09-04T13:04").getTimezoneOffset(), 0, "the run must be in a non-UTC zone for the D179 trap to be live");
assert.equal(new Date(Date.parse("2026-09-04T13:04")).toISOString(), "2026-09-04T11:04:00.000Z", "premise: Date.parse reads a zone-less date-time in the LOCAL zone");

const { isoFromField } = createRequire(fileURLToPath(import.meta.url))("./IncidentEditor.tsx") as typeof import("./IncidentEditor");

test("a zone-less field is read as UTC — the zone every label states — never in the browser's zone (D527/D179)", () => {
  assert.equal(isoFromField("2026-09-04 13:04"), "2026-09-04T13:04:00.000Z");
  assert.equal(isoFromField("2026-09-04T13:04"), "2026-09-04T13:04:00.000Z", "a T separator is the same shape");
  assert.equal(isoFromField("2026-09-04 13:04:05"), "2026-09-04T13:04:05.000Z", "seconds are kept");
  assert.equal(isoFromField("  2026-09-04 13:04 UTC  "), "2026-09-04T13:04:00.000Z", "the prefill's own `UTC` suffix and surrounding space are accepted");
  assert.equal(isoFromField("2026-09-04 13:04Z"), "2026-09-04T13:04:00.000Z");
});

test("text carrying its OWN zone is read in that zone (D527)", () => {
  assert.equal(isoFromField("2026-09-04T13:04:00+02:00"), "2026-09-04T11:04:00.000Z");
  assert.equal(isoFromField("2026-09-04T13:04:00.250-0500"), "2026-09-04T18:04:00.250Z");
  assert.equal(isoFromField("2026-09-04T13:04:00.000Z"), "2026-09-04T13:04:00.000Z", "the store's own ISO form round-trips byte for byte");
});

test("anything else is sent EMPTY — the store's refusal — never raw for the server to read in ITS zone (D179)", () => {
  for (const text of ["", "   ", "tomorrow", "2026-09-04", "13:04", "2026-13-40 99:99", "2026-09-04 13:04 CET", "04/09/2026 13:04"]) {
    assert.equal(isoFromField(text), "", `${JSON.stringify(text)} must not reach the server as an instant`);
  }
});
