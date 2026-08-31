import assert from "node:assert/strict";
import test from "node:test";
import { connectedSources } from "./connectors";
import { ingest } from "./workspace";
import { connectors } from "@/components/connections/connectors";

// run with: npm test --workspace apps/web
//
// THE CORRESPONDENCE BETWEEN THE DEMO'S SOURCES AND THE REAL CATALOG
// (S4.4 R2 must-fix 2).
//
// `connectedSources` is fabricated sample data, which D208 allows. What it may
// not do is fabricate a CAPABILITY: the connections wall renders these rows
// under "CONNECTED" and the catalog below them on the same screen, so a demo
// row wired to a `coming-soon` connector puts a contradiction on one page —
// "loopwork-web · Vercel · degraded" sitting 350px above the Vercel card that
// says the integration does not exist yet. That shipped for a sprint, and the
// landing page shipped a screenshot of it, because nothing here read the two
// files against each other.
//
// The `lib/infra-track.test.ts` shape: the unit rule, then the corpus checked
// against it, so the rule cannot be true of fixtures alone.

const bySlug = new Map(connectors.map((c) => [c.slug, c]));

test("every demo source is connected through a connector the product actually ships", () => {
  assert.ok(connectedSources.length > 0, "the demo has no connected sources — the panel would prove nothing");

  for (const source of connectedSources) {
    const connector = bySlug.get(source.connectorSlug);
    assert.ok(
      connector,
      `${source.name} is connected through "${source.connectorSlug}", which is not in the connector catalog`,
    );
    assert.equal(
      connector.status,
      "available",
      `${source.name} is shown as connected through ${connector.name}, which the catalog on the same screen lists as ${connector.status}`,
    );
  }
});

test("the check is capable of failing: the catalog really does hold both statuses", () => {
  // Without this the assertion above would pass on a catalog where every row
  // was available — a rule that cannot be broken is not a rule. The counts are
  // `connectors.test.ts`'s and `landing-fence.test.ts` check (d)'s: three of
  // nineteen.
  const comingSoon = connectors.filter((c) => c.status === "coming-soon");
  const available = connectors.filter((c) => c.status === "available");
  assert.ok(comingSoon.length > 0, "nothing in the catalog is coming-soon — this test can no longer fail");
  assert.ok(available.length > 0, "nothing in the catalog is available — the demo could not be honest at all");

  // And the resolution really resolves: a slug nobody defines is caught, not
  // silently skipped.
  assert.equal(bySlug.get("no-such-connector"), undefined);
});

test("the demo still demonstrates a source that is not healthy", () => {
  // The reason the replaced row existed: the panel's degraded/error rendering
  // needs a row to render. Swapping the connector must not quietly turn the
  // demo into three green ticks — that would be a different false claim about
  // what an ingest health panel is for.
  const unhealthy = connectedSources.filter((s) => s.status !== "healthy");
  assert.ok(unhealthy.length > 0, "no demo source is degraded or silent — the panel's error state is unexercised");
  assert.ok(
    unhealthy.some((s) => s.errorCount > 0),
    "no demo source carries an error count — the error column has nothing to show",
  );
});

// THE SAME RULE, ONE TAB OVER (S4.4 R3 must-fix 2).
//
// The check above reads the connections wall. `mock/workspace.ts`'s
// `ingest.droppedBySource` is the OTHER place the demo names a source — the
// settings Ingest tab, `SettingsSuite.tsx:~1161` — and it carried the row R2
// had just deleted: "Vercel log drain · 12 · unparseable JSON body", traffic
// and errors from a connector the catalog calls coming-soon and the demo no
// longer shows connected. It survived R2 because it is a string in a different
// file, rendered on a client tab no prerender sweep reads.
//
// So the mechanism, not another manual sweep: a dropped-source row may only
// name a source the demo actually shows as connected.
test("every dropped-source row names a source the demo shows as connected", () => {
  const connectedNames = new Set(connectedSources.map((s) => s.name));
  assert.ok(ingest.droppedBySource.length > 0, "the ingest tab's dropped-by-source panel is empty");

  for (const dropped of ingest.droppedBySource) {
    assert.ok(
      connectedNames.has(dropped.source),
      `ingest health attributes ${dropped.count} dropped record(s) to "${dropped.source}", ` +
        `which is not one of the demo's connected sources (${[...connectedNames].join(", ")})`,
    );
  }
});

test("the ingest tab's two numbers agree with each other", () => {
  // The panel prints the total above the rows that are supposed to explain it,
  // so a total that is not their sum is a contradiction on one screen — the
  // same class as the source name, caught by the same test file.
  const summed = ingest.droppedBySource.reduce((n, d) => n + d.count, 0);
  assert.equal(
    summed,
    ingest.droppedLast24h,
    "dropped (malformed) is not the sum of the per-source rows rendered underneath it",
  );
});

test("the dropped-source check is capable of failing", () => {
  // A rule that cannot be broken is not a rule (the arm above's own reasoning):
  // the demo has to have a source it does NOT show as connected for the
  // membership test to mean anything. Vercel — the exact row that was here —
  // is in the catalog and is not connected.
  const connectedNames = new Set(connectedSources.map((s) => s.name));
  assert.ok(!connectedNames.has("Vercel log drain"), "the deleted row came back");
  assert.ok(
    connectors.some((c) => c.slug === "vercel" && c.status === "coming-soon"),
    "vercel is no longer a coming-soon connector — pick another name for this arm",
  );
});
