import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { STATUS_COMPONENT_IDS } from "@/lib/docs/incidents";

// run with: npm test --workspace apps/web
//
// `/status` is obstack's own status page now (S4.4 T4, D256/D324). What stood
// here before was a demo of a fictional customer's page: ninety days of
// seeded-PRNG availability blocks, four components carrying invented figures,
// an invented resolved incident, and a header crediting it all to an obstack
// capability that does not exist. D256 deleted it with no relocation.
//
// This file is the fence that keeps it deleted, and it is a TEXT test for the
// same reason the shell tests are (D54(ii)): the page is a server component
// and the runner is pinned to `--conditions react-server`, so what can be
// asserted is the source — which is the right grain anyway, because every
// banned thing here is a literal somebody would type.
//
// THE NEEDLES ARE ASSEMBLED FROM PARTS, never spelled (the D246 discipline
// TourGuide.test.ts established). `apps/web/src` is swept for these phrases in
// the sprint's exit check; a test that spelled them would be the hit it is
// looking for, and the sweep's silence would then be a lie.

const HERE = path.dirname(import.meta.filename);
const WEB_SRC = path.resolve(HERE, "../..");
const read = (p: string) => readFileSync(path.join(WEB_SRC, p), "utf8");

/**
 * THE `/status` surface: the page and everything it reaches that is not
 * framework code. The incident modules are in here too — a percentage or a
 * fabricated state does not become acceptable by being one import away.
 */
const SURFACE: Record<string, string> = {
  "app/status/page.tsx": read("app/status/page.tsx"),
  "lib/docs/incidents.ts": read("lib/docs/incidents.ts"),
  "lib/docs/incidents-load.ts": read("lib/docs/incidents-load.ts"),
  "content/status/incidents/manifest.ts": read("content/status/incidents/manifest.ts"),
};
const pageSource = SURFACE["app/status/page.tsx"];
/** The page's text with JSX line-wrapping flattened, so a sentence can be matched as a sentence. */
const pageText = pageSource.replace(/\s+/g, " ");

test("D256: no number on this page claims availability", () => {
  // The single assertion the ruling names. A digit followed by `%` is the
  // shape of every uptime figure the deleted page carried, and there is no
  // honest one to write until an external monitor exists — so the rule is not
  // "no wrong numbers", it is "no numbers".
  for (const [name, source] of Object.entries(SURFACE)) {
    const hit = /\d%/.exec(source);
    assert.equal(hit, null, `${name} carries a percentage (${hit?.[0]}) — there is nothing measuring one`);
  }
});

test("D256: the deleted page's vocabulary does not come back", () => {
  // Assembled, never spelled — see the header. Each pair is a phrase from the
  // fiction: the fictional customer's page title and host, the credit to a
  // capability obstack does not have, the invented incident's id, the seeded
  // strip and its component, and the generator that fed it.
  const banned = [
    ["Loopwork", "status"].join(" "),
    ["status", "loopwork"].join("."),
    ["powered by obstack", "SLOs"].join(" "),
    ["INC", "42"].join("-"),
    ["All systems", "operational"].join(" "),
    ["uptime", "90d"].join(""),
    ["Uptime", "Strip"].join(""),
    ["mulberry", "32"].join(""),
    // A component cannot be labelled with a state at all: nothing measures
    // one, so the word is banned outright rather than only in its old phrase.
    ["operat", "ional"].join(""),
  ];
  for (const [name, source] of Object.entries(SURFACE)) {
    for (const phrase of banned) {
      assert.equal(source.includes(phrase), false, `${name} says "${phrase}" again`);
    }
  }
});

test("the page is mode-blind and reads no filesystem", () => {
  // `/status` is public and prerendered, and the `live` and `mock` images are
  // one build with a stamp between them (D251/D267): the page a stranger opens
  // must not depend on which image served it. The deleted page's import of the
  // demo corpus was the only one outside `src/mock/` — this is what keeps that
  // edge from being re-added by a refactor (D125/D158, S1 L2).
  for (const [name, source] of Object.entries(SURFACE)) {
    assert.equal(/from "@\/mock\//.test(source), false, `${name} imports a mock module`);
    assert.equal(source.includes("@/mock/"), false, `${name} names a mock module at all`);
    assert.equal(source.includes("resolveMode"), false, `${name} branches on the data mode`);
    assert.equal(source.includes("dataMode"), false, `${name} reads the data mode`);
    // D320: nothing that ships walks a directory. The manifest is the index.
    for (const banned of ['from "fs"', "from 'fs'", "node:fs", "node:path", 'from "path"', "readdirSync", "readFileSync"]) {
      assert.equal(source.includes(banned), false, `${name} reaches the filesystem (${banned})`);
    }
  }
});

test("every component is named and described, and none is scored", () => {
  // D324's shape: a name plus one true sentence about what the thing IS.
  // The ids are not re-declared here — they come from the module a notice's
  // `components` field is checked against, so this fails if the page and the
  // notices ever stop talking about the same three things.
  assert.deepEqual([...STATUS_COMPONENT_IDS], ["app", "ingest", "docs"]);
  for (const id of STATUS_COMPONENT_IDS) {
    assert.ok(
      new RegExp(`\\b${id}:\\s*"`).test(pageSource),
      `the page has no sentence for the "${id}" component`,
    );
  }
  assert.ok(pageText.includes("The web application — the demo today, and your workspace once it exists."));
  assert.ok(pageText.includes("The OTLP endpoint your telemetry is sent to."));
  assert.ok(pageText.includes("This site's documentation."));
  // The list is rendered BY mapping the id array, so a fourth component cannot
  // appear on the page without becoming a component a notice can name.
  assert.ok(
    pageSource.includes("STATUS_COMPONENT_IDS.map("),
    "the page no longer renders the shared id list — a component could drift onto it alone",
  );
});

test("D256: the monitoring slot says what is true, in the ruled words", () => {
  assert.ok(
    pageText.includes(
      "External uptime monitoring begins at launch; this page shows no uptime numbers until then.",
    ),
    "the monitoring sentence is not on the page verbatim — it is the whole of what this section may claim",
  );
});

test("D324: with nothing published, the incidents section is one sentence", () => {
  assert.ok(
    pageText.includes("No incidents recorded."),
    "the empty state is gone — an empty incident history must say so, not render nothing",
  );
  // The list comes from the loader, not from a literal in the page: an
  // incident on this page is a file somebody wrote.
  assert.ok(pageSource.includes('from "@/lib/docs/incidents-load"'));
  assert.ok(pageSource.includes("await loadIncidents()"));
});

test("D324: the SLO surface no longer links here", () => {
  // `app/app/slos/page.tsx` is an M6 mock surface. Its link read "public
  // status page", which implied this page is fed by those SLOs — the exact
  // claim D256 deleted. The link is removed rather than repointed, because
  // the implication travelled with the link and not with its href.
  const slos = read("app/app/slos/page.tsx");
  assert.equal(slos.includes('"/status"'), false, "the SLO page links at /status again");
  assert.equal(slos.includes("status page"), false, "the SLO page still offers a status page");
  // The palette entry is the one inbound link that stays (D324): it is a
  // navigation list, and the destination is a real public page.
  const palette = read("components/shell/CommandPalette.tsx");
  assert.equal(
    palette.split('href: "/status"').length - 1,
    1,
    "the command palette must offer /status exactly once",
  );
});
