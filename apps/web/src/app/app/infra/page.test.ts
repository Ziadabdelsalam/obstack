import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { resolvedImports } from "@/test-utils/import-specifiers";

// run with: npm test --workspace apps/web
//
// The D367/D459 guard for `/app/infra`, as a SOURCE-TEXT test (D391a): the rule
// is what these three files SAY, never what their transitive import graph
// resolves to — `@/server/data` statically imports `@/mock/*` for its own mock
// branch, so a graph-level claim is not one anybody can make. Source is also the
// only option available: importing the real modules here would pull `next/link`
// and `lucide-react` into a `--conditions react-server` process, where React
// exports no `createContext` (explore/page.test.ts, D54(iii)).
const HERE = path.dirname(fileURLToPath(import.meta.url));
const resolve = (file: string) => path.join(HERE, file);
const read = (file: string) => readFileSync(resolve(file), "utf8");

/**
 * Comments stripped, so every claim below is a claim about the CODE. All three
 * files explain themselves in prose that quotes the very things this test
 * forbids — the mock module path, the word `await`, the missing-metric glyph —
 * and a rule read off the raw text would be a rule against documenting the rule.
 */
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

const PAGE_PATH = resolve("page.tsx");
const LIVE_PATH = resolve("../../../components/infra/InfraLive.tsx");
const PAGE = code(read("page.tsx"));
const MOCK = code(read("../../../components/infra/InfraMock.tsx"));
const LIVE = code(read("../../../components/infra/InfraLive.tsx"));

test("the page branches on dataMode and returns the moved mock body first (D367)", () => {
  assert.match(
    PAGE,
    /if \(dataMode !== "live"\) return <InfraMock \/>;/,
    "the mock branch must return InfraMock with no props, and nothing else",
  );
  const branch = PAGE.indexOf('if (dataMode !== "live")');
  const firstAwait = PAGE.indexOf("await ");
  assert.ok(branch >= 0, "infra/page.tsx has no dataMode branch");
  assert.ok(firstAwait >= 0, "infra/page.tsx has no live-only await — the guard would pass vacuously");
  assert.ok(
    branch < firstAwait,
    "the page must return its mock component before the first await, so the mock render stays static",
  );
  // The scope is the SESSION's workspace, injected here and never taken from a
  // caller (run-goal condition 2) — and the snapshot is resolved on the server,
  // so `InfraLive` receives data rather than a promise or a query function.
  assert.match(
    PAGE,
    /<InfraLive snapshot=\{await queryInfraSnapshot\(forWorkspace\(session\.workspaceId\)\)\} \/>/,
  );
  assert.match(PAGE, /if \(!session\) redirect\("\/login"\);/);
});

test("A2/D392: the page and the live component read no fixture and ship no client JS", () => {
  // Every ban below reads what an import RESOLVES to, never the alias someone
  // happened to type (`resolvedImports`, D448).
  for (const [label, src, filePath] of [
    ["infra/page.tsx", PAGE, PAGE_PATH],
    ["InfraLive.tsx", LIVE, LIVE_PATH],
  ] as const) {
    assert.equal(
      resolvedImports(src, filePath).some((spec) => /(^|\/)mock\//.test(spec)),
      false,
      `${label} must not depend on any mock module — InfraMock owns that import`,
    );
  }
  assert.equal(
    LIVE.includes('"use client"'),
    false,
    "InfraLive is a server component — every control on it is a <Link>, so there is no interactivity to ship JS for",
  );
  assert.ok(MOCK.includes('from "@/mock/infra"'), "the fixture import belongs to the mock half");
  assert.ok(
    LIVE.includes('from "@/lib/infra-types"'),
    "the live half reads the frozen contract's caps and types, not its own copies (D456)",
  );
});

test("D459: the four states are on the live surface with their exact sentences", () => {
  // (a) neither leg — the empty state, its doc link, and no table at all.
  assert.ok(
    LIVE.includes(
      "No cluster metrics yet. The obstack-collector chart ships node and pod metrics from chart 0.6.0 — install or upgrade it, and this page fills in from the kubelet and the cluster API.",
    ),
    "the D459(a) empty-state sentence is not on the live surface, verbatim",
  );
  assert.ok(LIVE.includes('href="/app/docs/self-hosting/helm-chart"'));
  assert.match(LIVE, />\s*Helm chart docs\s*<\/Link>/, "the D459(a) link text is not \"Helm chart docs\"");
  assert.match(
    LIVE,
    /if \(!hasKubeletMetrics && !hasClusterMetrics\) \{[\s\S]*?\n  \}/,
    "the empty state must be its own early return — a table under that sentence would be the render it denies",
  );
  const emptyState = LIVE.slice(
    LIVE.indexOf("if (!hasKubeletMetrics && !hasClusterMetrics) {"),
    LIVE.indexOf("const note ="),
  );
  assert.equal(emptyState.includes("<table"), false, "D459(a) renders no table");
  assert.equal(emptyState.includes("right-sizing"), false, "D459(a) renders no recs panel");

  // (b) kubelet only, (d) cluster only — one note each, above the tables, each
  // NAMING the leg that is missing (D13).
  assert.ok(
    LIVE.includes(
      "Readiness, pod phase, restarts, requests and limits come from the cluster collector (collector.cluster.enabled), which is off or not yet reporting — those cells show — until it does.",
    ),
    "the D459(b) kubelet-only note is not on the live surface, verbatim",
  );
  assert.ok(
    LIVE.includes(
      "CPU and memory usage come from the node collector (the DaemonSet's kubelet_stats receiver), which is not reporting — check its nodes/stats access; usage cells show — until it does.",
    ),
    "the D459(d) cluster-only note is not on the live surface, verbatim",
  );
  assert.match(
    LIVE,
    /const note = !hasClusterMetrics \? KUBELET_ONLY_NOTE : !hasKubeletMetrics \? CLUSTER_ONLY_NOTE : null;/,
    "(c) both legs reporting is the one state with no note",
  );

  // The header states the counts and the clock, and NOTHING the metric stream
  // does not carry — no cluster name, no provider, no "synced via".
  assert.ok(
    LIVE.includes(
      "{`${totalNodes} nodes · ${totalPods} pods · as of ${asOf === null ? MISSING : fmtClock(asOf)}`}",
    ),
    "the D459 header sentence is not one string — the rendered HTML would carry Fizz's separators through it",
  );
  for (const invented of ["GKE", "prod-cluster", "synced via", "provider"]) {
    assert.equal(LIVE.includes(invented), false, `the live header invented "${invented}"`);
  }
});

test("D459: the pod table's columns are the ruled ones, and `age` is not among them", () => {
  const headers = [...LIVE.matchAll(/<th[^>]*>([^<]+)<\/th>/g)].map((m) => m[1].trim());
  assert.deepEqual(headers, ["pod", "node", "phase", "restarts", "memory", "cpu", "drill"]);
  // Scope fence (run-goal condition 10): the metric stream carries no pod age,
  // and "restarts" carries no window because the cluster collector reports the
  // container's lifetime count.
  assert.equal(LIVE.includes("restarts 24h"), false);
  assert.ok(LIVE.includes("{`${p.namespace}/${p.name}`}"), "the pod cell is `ns/name`");
  assert.ok(
    LIVE.includes("`/app/logs?pod=${encodeURIComponent(p.name)}`"),
    "the pod row must deep-link to the logs surface's pod FILTER with the whole name (D61)",
  );
  // Every null cell is the glyph, never a zero (D13).
  for (const cell of ["p.node ?? MISSING", "p.phase ?? MISSING", "p.restarts === null ? MISSING"]) {
    assert.ok(LIVE.includes(cell), `the pod table fabricates a value where the contract returned null: ${cell}`);
  }
  // A ratio needs both legs: the limit is stated only when the pod's limit is
  // COMPLETE (D457) and the percentage only when usage is there too.
  assert.ok(LIVE.includes("if (limit === null) return observed;"));
  assert.ok(LIVE.includes("used !== null && limit > 0 ? ` · ${Math.round((used / limit) * 100)}%` : \"\""));
  // Node cards: the bar is a percentage of allocatable, or the absolute value
  // when the cluster leg has not said what allocatable is.
  assert.ok(LIVE.includes("used !== null && allocatable !== null && allocatable > 0"));
  assert.match(
    LIVE,
    /n\.ready === null\s*\?\s*"var\(--color-faint\)"/,
    "the ready dot must be grey when readiness is unknown, not green",
  );
});

test("D458: the recs panel states its basis, its three sentences and its per-state bodies", () => {
  assert.ok(
    LIVE.includes(
      "Peak usage against each container's current limit over the last 24h; a limit is called oversized only after 12h of observation. No prices — obstack has no price input for compute.",
    ),
    "the D458 basis line is not on the panel, verbatim",
  );
  assert.ok(LIVE.includes("Nothing to right-size in the last 24h."));
  assert.ok(LIVE.includes("Right-sizing needs container limits from the cluster collector."));
  assert.ok(LIVE.includes("Right-sizing needs usage from the node collector."));
  // The basis line renders outside every branch of the panel's body, so it is
  // stated whether or not the panel has anything to say.
  assert.match(LIVE, /\)\}\s*<p[^>]*>\{RECS_BASIS\}<\/p>/);
  // The three sentences, with R and H rounded as ruled.
  assert.ok(
    LIVE.includes(
      "return `${target} peaked at ${pct}% of its ${fmtCores(r.limit)} CPU limit over the last ${hours}h — near its limit`;",
    ),
  );
  assert.ok(
    LIVE.includes(
      "return `${target} peaked at ${pct}% of its ${fmtBytes(r.limit)} memory limit over the last ${hours}h — ${verdict}`;",
    ),
  );
  assert.ok(LIVE.includes('r.kind === "memory-limit-oversized" ? "the limit is oversized" : "near its limit"'));
  assert.ok(LIVE.includes("const pct = Math.round(r.ratio * 100);"));
  assert.ok(LIVE.includes("const hours = Math.round(r.observedHours);"));
});

test("D362: the live infra surface carries no price and no sample mark", () => {
  // The right-sizing answer has no dollar figure BY CONSTRUCTION — obstack has
  // no price input for compute (`RightsizingRec` carries no such field) — and a
  // `SampleMark` over a fabricated one would be the fence D362 forbids: the
  // figure is ABSENT, not labelled.
  assert.equal(/\$\d/.test(LIVE), false, "a currency figure reached the live infra surface");
  assert.equal(LIVE.includes("SampleMark"), false, "no fenced figure stands in for a price here");
  for (const word of ["savings", "save $", "apply"]) {
    assert.equal(LIVE.toLowerCase().includes(word), false, `the recs panel offers "${word}"`);
  }
});

test("D402: each cap sentence renders only when that cap cut something", () => {
  for (const [total, cap, sentence] of [
    ["totalNodes", "INFRA_NODE_CAP", "showing ${INFRA_NODE_CAP} of ${totalNodes} nodes"],
    ["totalPods", "INFRA_POD_CAP", "showing ${INFRA_POD_CAP} of ${totalPods} pods"],
    ["totalRecs", "INFRA_RECS_CAP", "showing ${INFRA_RECS_CAP} of ${totalRecs} recommendations"],
  ] as const) {
    assert.ok(LIVE.includes(`{${total} > ${cap} && (`), `the ${total} cap sentence is not behind its own truncation test`);
    assert.ok(LIVE.includes(sentence), `the ${total} cap sentence does not read as ruled`);
  }
});

test("the mock body is the untouched page body, moved (S6.2 byte-identity)", () => {
  assert.match(MOCK, /export function InfraMock\(\)\s*\{/, "InfraMock must take no props");
  // Pinned markers from the original 159-line body: every one of them names a
  // fixture-only field the live surface cannot derive (a node pool, a GKE
  // cluster name, a pod age, a right-sizing dollar impact), so they can only
  // live here — and if one moves or vanishes, the verbatim move this test
  // exists to catch has drifted.
  for (const marker of [
    "prod-cluster (GKE) · 4 nodes · {pods.length} pods · synced via obstack-collector",
    "{n.pool} · {n.pods} pods",
    'p.node.replace("gke-prod-", "")',
    "restarts 24h",
    "{p.rssMi}/{p.limitMi}Mi",
    "{p.age}",
    "rightsizing.map((r)",
    "→ {r.impact}",
    "derived from 30d of pod telemetry",
  ]) {
    assert.ok(MOCK.includes(marker), `InfraMock lost "${marker}"`);
  }
  // The moved body keeps its own pod deep link (the companion glob guard in
  // `lib/logs-filter.test.ts` holds the contract for both halves).
  assert.ok(MOCK.includes("`/app/logs?pod=${encodeURIComponent(p.name)}`"));
});
