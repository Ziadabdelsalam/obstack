import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { OTLP_HTTP_ENDPOINT } from "@/lib/ingest-endpoint";
import { isLiveWiredRoute } from "@/lib/live-routes";

// run with: npm test --workspace apps/web
//
// THE DOCS MIRROR (S4.4 T2, the D206/D266 shape).
//
// Every number, name, range, route and command in the corpus was copied out of
// a file in this repository. A comment saying so is not a check — so this file
// re-reads each of those sources as TEXT and fails when the page and the source
// stop agreeing. The failure mode it exists for is not a wrong doc: it is a
// RIGHT doc that quietly became wrong when somebody bumped a peer range, moved
// a route, renamed a chart value or changed a plan's quota, three sprints from
// now, with no reason to open the docs at all.
//
// Text, not import, throughout: the runner has no MDX loader, the Go and SQL
// sources are not JavaScript, and the thing being checked is a literal a reader
// would copy in every case.
//
// The rule this file applies (D322's generalisation): a value with a shared
// definition is RENDERED from it — the quickstart snippets and the endpoints
// come from `@/components/docs/QuickstartSnippets` — and everything with no
// shared definition to render from has its literal asserted equal to the
// source's here.

const HERE = path.dirname(import.meta.filename);
const WEB_SRC = path.resolve(HERE, "../..");
const REPO_ROOT = path.resolve(HERE, "../../../../..");
const DOCS = path.join(WEB_SRC, "content/docs");

const repo = (p: string) => readFileSync(path.join(REPO_ROOT, p), "utf8");
const page = (slug: string) => readFileSync(path.join(DOCS, slug, "index.mdx"), "utf8");

/** Line breaks are a wrapping decision; a claim is the same claim either way. */
const flat = (s: string) => s.replace(/\s+/g, " ").trim();

/** A blockquote as the sentence it quotes: the `>` markers are markdown, not text. */
const prose = (s: string) => flat(s.replace(/^>\s?/gm, ""));

const pages = {
  quickstart: page("quickstart"),
  typescript: page("sdks/typescript"),
  python: page("sdks/python"),
  byoOtel: page("sdks/bring-your-own-otel"),
  compose: page("self-hosting/docker-compose"),
  helm: page("self-hosting/helm-chart"),
  connectors: page("connectors/overview"),
  vercel: page("connectors/vercel-log-drains"),
  cloudwatch: page("connectors/aws-cloudwatch"),
  explain: page("explain"),
  retention: page("retention"),
  billing: page("billing-and-plans"),
  absences: page("what-obstack-does-not-do"),
  accounts: page("accounts-and-access"),
};

/** Every page in the corpus, for the checks that are about the whole tree. */
function allPages(dir: string): { file: string; source: string }[] {
  const out: { file: string; source: string }[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...allPages(full));
    else if (entry.name === "index.mdx") {
      out.push({ file: path.relative(DOCS, full), source: readFileSync(full, "utf8") });
    }
  }
  return out;
}
const corpus = allPages(DOCS);
const corpusText = corpus.map((p) => p.source).join("\n");

// ---------------------------------------------------------------------------
// The SDKs
// ---------------------------------------------------------------------------

test("the TypeScript coverage table's peer ranges are package.json's", () => {
  // The same mirror `Quickstart.test.ts:245-286` keeps over the in-app version
  // fence (D311), applied to the docs page that reprints the coverage table.
  // A range widened in the package and not here would advertise coverage that
  // is not measured — which is exactly how the `ai` fence went stale once.
  const pkg = JSON.parse(repo("packages/obstack-js/package.json")) as {
    peerDependencies: Record<string, string>;
  };
  const flatPage = flat(pages.typescript);
  const entries = Object.entries(pkg.peerDependencies);
  assert.equal(entries.length, 3, "obstack-js declares a different number of optional peers now");
  for (const [name, range] of entries) {
    assert.ok(
      flatPage.includes(`${name} ${range}`),
      `/docs/sdks/typescript does not state ${name} ${range} — the docs and package.json have drifted`,
    );
  }
});

test("the Python page's dependency ranges are pyproject.toml's", () => {
  const pyproject = repo("packages/obstack-py/pyproject.toml");
  const block = pyproject.slice(
    pyproject.indexOf("dependencies = ["),
    pyproject.indexOf("]", pyproject.indexOf("dependencies = [")),
  );
  const deps = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(deps.length >= 4, "no dependency list parsed out of pyproject.toml");
  const flatPage = flat(pages.python);
  for (const dep of deps) {
    assert.ok(flatPage.includes(dep), `/docs/sdks/python does not state ${dep}`);
  }
  const requires = pyproject.match(/requires-python = "([^"]+)"/);
  assert.ok(requires, "pyproject.toml states no requires-python");
  assert.ok(
    flatPage.includes(`requires-python = "${requires[1]}"`),
    `/docs/sdks/python does not state requires-python = "${requires[1]}"`,
  );
});

test("the Python environment table is the README's, row for row", () => {
  // The table is rendered by `@/components/docs/QuickstartSnippets`, not
  // written into the page — `Quickstart.test.ts` bans an exporter variable in
  // the corpus, and a table of them is the same second copy a snippet would
  // be. So the mirror is component ↔ README, with the endpoint example
  // substituted the way the component interpolates it.
  const readme = repo("packages/obstack-py/README.md");
  const envSection = readme.slice(readme.indexOf("## Environment"));
  const rows = envSection
    .split("\n")
    .filter((line) => line.startsWith("| `"))
    .map((line) => line.split("|").slice(1, -1).map(strip))
    .filter((cells) => cells.length === 2);
  assert.equal(rows.length, 6, "the README's environment table changed shape");

  const component = readFileSync(
    path.join(WEB_SRC, "components/docs/QuickstartSnippets.tsx"),
    "utf8",
  ).split("${OTLP_HTTP_ENDPOINT}").join(OTLP_HTTP_ENDPOINT);
  const flatComponent = flat(component);
  for (const [variable, purpose] of rows) {
    assert.ok(flatComponent.includes(variable), `OtelEnvTable is missing ${variable}`);
    assert.ok(
      flatComponent.includes(purpose),
      `OtelEnvTable's row for ${variable} does not say what the README says: ${purpose}`,
    );
  }
  assert.ok(
    pages.python.includes("<OtelEnvTable />"),
    "/docs/sdks/python no longer renders the table this test just checked",
  );
});

/** A markdown cell as prose: emphasis and code fences are formatting, not content. */
function strip(cell: string): string {
  return flat(cell.replace(/`/g, "").replace(/\*\*/g, ""));
}

test("the layer table on the bring-your-own-OTel page is the ingest classifier's rule", () => {
  // The page that tells a stranger with a stock OTel setup which attributes to
  // emit. Every name in its table is a promise made by `classify` in
  // `services/ingest/internal/mapping/spans.go`, and the promise is not the
  // page's to restate — it was WRONG when this test was written: the api row
  // named `http.request.method` alone, and the paragraph under it said the api
  // layer "disappears" without `OTEL_SEMCONV_STABILITY_OPT_IN=http`. The
  // classifier takes `http.route` as well (`mapping_test.go`'s "api by route"),
  // and the pinned FastAPI instrumentation writes `http.route` in either
  // semconv mode — so the instruction was a fix for a breakage that could not
  // happen, and the table understated what obstack reads.
  const mapping = repo("services/ingest/internal/mapping/mapping.go");
  const spans = repo("services/ingest/internal/mapping/spans.go");
  const attr = (name: string) => {
    const match = mapping.match(new RegExp(`${name}\\s*= "([^"]+)"`));
    assert.ok(match, `mapping.go no longer defines ${name}`);
    return match[1];
  };
  const start = spans.indexOf("func classify(");
  assert.ok(start > 0, "the classifier is no longer a function called classify in spans.go");
  const classify = spans.slice(start, spans.indexOf("\n}", start));

  const flatPage = flat(pages.byoOtel);
  // Every attribute the classifier reads by name is a row on the page. The
  // `gen_ai` case is a PREFIX rather than a constant, so it is checked as one.
  for (const name of ["attrAgentStep", "attrToolName", "attrHTTPMethod", "attrHTTPRoute"]) {
    assert.ok(classify.includes(`attrs.Get(${name})`), `classify no longer reads ${name}`);
    // Opening backtick only: the marker rows print the attribute WITH its value
    // (`` `obstack.agent.step="<name>"` ``), so a closed span would be a check
    // on the page's formatting rather than on the name.
    assert.ok(
      flatPage.includes(`\`${attr(name)}`),
      `/docs/sdks/bring-your-own-otel never names ${attr(name)}, which classify reads`,
    );
  }
  const prefix = mapping.match(/genAIPrefix\s*= "([^"]+)"/);
  assert.ok(prefix, "mapping.go no longer defines the GenAI prefix");
  assert.ok(classify.includes("HasPrefix(k, genAIPrefix)"), "classify no longer matches the GenAI prefix");
  assert.ok(flatPage.includes(`\`${prefix[1]}*\``), `the page does not name ${prefix[1]}* as the llm rule`);

  // The api layer's two attributes are alternatives, and the page has to say so
  // — an author reading "or" emits one; an author reading the old row emits the
  // one attribute the semconv opt-in governs and believes the layer depends on
  // it. The disproved sentence is banned by shape, not quoted: `http.route`
  // arrives in both modes, so nothing about the api layer is conditional on the
  // variable.
  assert.ok(
    flatPage.includes(`\`${attr("attrHTTPMethod")}\` **or** \`${attr("attrHTTPRoute")}\``),
    "the api row no longer states that either HTTP attribute alone classifies the span",
  );
  assert.equal(
    /api layer (disappears|dies|is lost)/.test(flatPage),
    false,
    "the page claims the api layer depends on the semconv opt-in — it does not, http.route is emitted either way",
  );
});

// ---------------------------------------------------------------------------
// Self-hosting
// ---------------------------------------------------------------------------

test("every OBSTACK_* variable the docs name is a variable this repo defines", () => {
  // The docs are the one place these names are read by somebody who cannot
  // grep for them. A typo here is a variable an operator sets that nothing
  // ever reads, and the symptom is silence.
  const definitions = [
    "deploy/compose/.env.example",
    "deploy/compose/docker-compose.yml",
    "deploy/helm/obstack/values.yaml",
    "deploy/cloudwatch-forwarder/README.md",
    "services/ingest/internal/config/config.go",
    "apps/web/src/server/explain/anthropic.ts",
    "apps/web/src/server/explain/client.ts",
    "apps/web/src/server/ingest-endpoint.ts",
    "apps/web/src/server/mcp-endpoint.ts",
    "apps/web/src/server/mode-stamp.ts",
    "apps/web/src/lib/status-monitor.ts",
  ]
    .map(repo)
    .join("\n");
  const named = new Set(corpusText.match(/\bOBSTACK_[A-Z0-9_]+/g) ?? []);
  assert.ok(named.size > 5, "the corpus names almost no obstack variables — did the pages move?");
  for (const name of named) {
    assert.ok(definitions.includes(name), `the docs name ${name}, which nothing in this repo defines`);
  }
  // The compose bundle's one REQUIRED setting has to be on the compose page:
  // an install that misses it never reaches healthy.
  const envExample = repo("deploy/compose/.env.example");
  const required = envExample.match(/^(OBSTACK_[A-Z0-9_]+)=/m);
  assert.ok(required, ".env.example no longer has an uncommented (required) setting");
  assert.ok(
    pages.compose.includes(required[1]),
    `/docs/self-hosting/docker-compose does not name ${required[1]}, the one required setting`,
  );
});

test("every chart value the helm page names resolves in values.yaml", () => {
  const values = repo("deploy/helm/obstack/values.yaml");
  const named = new Set(
    (flat(pages.helm).match(
      /\b(?:clickhouse|postgres|web|ingest|collector|demo)(?:\.[A-Za-z][A-Za-z0-9]*)+/g,
    ) ?? []),
  );
  assert.ok(named.size > 10, "the helm page names almost no chart values — did it move?");
  for (const key of named) {
    assert.ok(resolvesInYaml(values, key.split(".")), `values.yaml has no ${key}`);
  }
});

/**
 * Does `a.b.c` exist in this values file? Indentation-only, because the whole
 * point is to read the source as text rather than to depend on a YAML parser
 * this repo does not carry.
 */
function resolvesInYaml(yaml: string, keyPath: string[]): boolean {
  let depth = 0;
  let index = 0;
  const lines = yaml.split("\n");
  for (const segment of keyPath) {
    let found = -1;
    for (let i = index; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim() || line.trim().startsWith("#")) continue;
      const indent = line.length - line.trimStart().length;
      if (depth > 0 && indent < depth) break; // left the parent's block
      if (indent === depth && line.trim().startsWith(`${segment}:`)) {
        found = i;
        break;
      }
    }
    if (found === -1) return false;
    index = found + 1;
    depth += 2;
  }
  return true;
}

test("the ingest shutdown grace is one number in three places", () => {
  // D263/D278: the chart's grace period, compose's, and the sentence both docs
  // pages state. A change to the shutdown ladder that moved one of them and
  // not the others would leave a doc quietly promising the old bound.
  const chart = repo("deploy/helm/obstack/templates/ingest/deployment.yaml");
  const seconds = chart.match(/terminationGracePeriodSeconds: (\d+)/);
  assert.ok(seconds, "the ingest Deployment no longer sets a termination grace period");
  assert.ok(
    repo("deploy/compose/docker-compose.yml").includes(`stop_grace_period: ${seconds[1]}s`),
    `compose's ingest grace is no longer ${seconds[1]}s`,
  );
  assert.ok(
    pages.helm.includes(`terminationGracePeriodSeconds: ${seconds[1]}`),
    "/docs/self-hosting/helm-chart states a different grace period",
  );
  assert.ok(
    pages.compose.includes(`stop_grace_period: ${seconds[1]}s`),
    "/docs/self-hosting/docker-compose states a different grace period",
  );
});

test("the helm command the docs print installs the chart that is in this repo", () => {
  // `corpus-honesty.test.ts` checks the chart PATH exists; this checks the docs
  // did not paraphrase the chart README's own line into something that would
  // time out or install without its secret.
  const chartReadme = repo("deploy/helm/obstack/README.md");
  const line = "helm install obstack deploy/helm/obstack --timeout 900s --wait";
  assert.ok(chartReadme.includes(line), "the chart README's install line moved");
  assert.ok(pages.helm.includes(line), "/docs/self-hosting/helm-chart no longer prints that line");
});

// ---------------------------------------------------------------------------
// Connectors
// ---------------------------------------------------------------------------

test("the connector counts and names are the catalog's", () => {
  const catalog = readFileSync(
    path.join(WEB_SRC, "components/connections/connectors.ts"),
    "utf8",
  );
  // Blocks, so a name is paired with its OWN status rather than counted
  // separately — the count and the list have to disagree for that to matter,
  // which is exactly the drift worth catching.
  const entries = [...catalog.matchAll(/name: "([^"]+)",[\s\S]*?status: "(available|coming-soon)"/g)].map(
    ([, name, status]) => ({ name, status }),
  );
  const available = entries.filter((e) => e.status === "available");
  const soon = entries.filter((e) => e.status === "coming-soon");
  assert.ok(available.length > 0 && soon.length > 0, "no connectors parsed out of the catalog");
  assert.equal(
    entries.length,
    available.length + soon.length,
    "a connector carries a status this test does not know about",
  );

  const flatPage = flat(pages.connectors);
  assert.ok(
    flatPage.includes(`**${available.length} available**`),
    `/docs/connectors/overview does not say ${available.length} available`,
  );
  assert.ok(
    flatPage.includes(`**${soon.length} coming soon**`),
    `/docs/connectors/overview does not say ${soon.length} coming soon`,
  );
  assert.ok(
    flatPage.includes(`holds ${entries.length} cards`),
    `/docs/connectors/overview does not say the catalog holds ${entries.length} cards`,
  );
  for (const entry of entries) {
    assert.ok(flatPage.includes(entry.name), `/docs/connectors/overview never names ${entry.name}`);
  }
  // The rest of the catalog, counted rather than restated: "the other
  // thirteen" is a number the page states and this is where it comes from —
  // the coming-soon cards minus the THREE that have a route on ingest today
  // (Vercel drains, CloudWatch, and since S7.2 the GitHub Actions deploy hook).
  assert.ok(
    flatPage.includes(`The other ${numberWord(soon.length - 3)} are names on cards`),
    "the overview's count of untouched cards no longer follows from the catalog",
  );
});

/** The few number words the corpus spells out. */
function numberWord(n: number): string {
  const words = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
    "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen"];
  assert.ok(words[n], `no word for ${n}`);
  return words[n];
}

test("the receiver routes the connector pages print are the routes ingest registers", () => {
  const http = repo("services/ingest/internal/receive/http.go");
  const prefix = http.match(/integrationsPrefix = "([^"]+)"/);
  assert.ok(prefix, "http.go no longer defines the integrations prefix");
  const registered = [...http.matchAll(/mux\.HandleFunc\("POST "\+integrationsPrefix\+"([a-z]+)"/g)].map(
    (m) => `${prefix[1]}${m[1]}`,
  );
  assert.deepEqual(
    registered.sort(),
    ["/v1/integrations/cloudwatch", "/v1/integrations/vercel"],
    "ingest registers a different set of integration routes than the docs describe",
  );
  assert.ok(pages.vercel.includes("/v1/integrations/vercel"), "the Vercel page's route moved");
  assert.ok(
    pages.cloudwatch.includes("/v1/integrations/cloudwatch"),
    "the CloudWatch page's route moved",
  );
});

test("the CloudWatch page carries the forwarder README's honest-status paragraph", () => {
  const readme = repo("deploy/cloudwatch-forwarder/README.md");
  const start = readme.indexOf("**Status, honestly:");
  assert.ok(start > 0, "the forwarder README's status paragraph moved");
  const paragraph = flat(readme.slice(start, readme.indexOf("\n\n", start)));
  assert.ok(
    flat(pages.cloudwatch).includes(paragraph),
    "/docs/connectors/aws-cloudwatch no longer carries the forwarder's own status paragraph verbatim",
  );
});

// ---------------------------------------------------------------------------
// Plans, Explain, retention
// ---------------------------------------------------------------------------

/** The plan catalog, parsed out of the migration that seeds it (CS3). */
function plans() {
  const seed = repo("services/ingest/pgmigrations/0005_metering.sql");
  const row = (id: string) => {
    const match = seed.match(
      new RegExp(`\\('${id}', '[A-Za-z]+', (\\d+), (\\d+), (\\d+)\\)`),
    );
    assert.ok(match, `0005_metering.sql no longer seeds the ${id} plan`);
    return { events: Number(match[1]), retention: Number(match[2]), price: Number(match[3]) };
  };
  const quota = repo("services/ingest/pgmigrations/0006_explain_quota.sql").match(
    /WHEN 'free' THEN (\d+) WHEN 'pro' THEN (\d+)/,
  );
  assert.ok(quota, "0006_explain_quota.sql no longer sets both explain quotas");
  return {
    free: { ...row("free"), explain: Number(quota[1]) },
    pro: { ...row("pro"), explain: Number(quota[2]) },
  };
}

test("every plan number in the docs is a column in the seeded catalog", () => {
  // CS3: `plans` is the ONLY true pricing source. There is no `scale` row, no
  // overage column and no seat column, so a docs table that carries one is
  // carrying a PRD hypothesis as a price.
  const { free, pro } = plans();
  const fmt = (n: number) => n.toLocaleString("en-US");
  for (const row of [
    `| Price | $${free.price} | $${pro.price} / month |`,
    `| Events per month | ${fmt(free.events)} | ${fmt(pro.events)} |`,
    `| Retention | ${free.retention} days | ${pro.retention} days |`,
    `| Explain runs per month | ${free.explain} | ${pro.explain} |`,
  ]) {
    assert.ok(pages.billing.includes(row), `/docs/billing-and-plans is missing: ${row}`);
  }
  assert.ok(
    flat(pages.explain).includes(`**${free.explain} runs on free, ${pro.explain} on pro**`),
    "/docs/explain states different Explain quotas than the catalog seeds",
  );
});

test("no docs page carries the mock billing tab's fiction", () => {
  // CS3's forbidden list: the mock `BillingTab` and the mock ingest/audit copy
  // are PRD hypotheses with no catalog column behind them.
  for (const lie of [
    "$1.50 per 100k",
    "1.50 per",
    "Unlimited seats",
    "unlimited seats",
    "90-day audit retention",
  ]) {
    for (const p of corpus) {
      assert.equal(p.source.includes(lie), false, `${p.file} carries the mock billing copy: ${lie}`);
    }
  }
  // The absence itself is stated, so a reader who has seen the old copy knows
  // it was not simply left out.
  assert.ok(
    flat(pages.billing).includes(
      "There is no Scale plan, no per-event overage and no seat count in the catalog",
    ),
    "/docs/billing-and-plans no longer states what the catalog does NOT have",
  );
});

test("the three Explain refusals are the strings the product actually renders", () => {
  const notConfigured = repo("apps/web/src/server/explain/anthropic.ts");
  const start = notConfigured.indexOf("export const NOT_CONFIGURED_DETAIL =");
  assert.ok(start > 0, "NOT_CONFIGURED_DETAIL moved");
  const detail = flat(
    notConfigured
      .slice(start, notConfigured.indexOf(";", start))
      .split('"')
      .filter((_, i) => i % 2 === 1)
      .join(""),
  );
  assert.ok(
    prose(pages.explain).includes(detail),
    "/docs/explain quotes a not-configured refusal the product does not send",
  );

  // The quota's own sentence lives with the quota since S7.4 (D551 lifted it
  // out of the traces route because the incident RCA route refuses with the
  // same words). Moving the function before this path was edited turned this
  // line red, which is how the path is known to be read rather than believed.
  const quotaModule = repo("apps/web/src/server/explain/quota.ts");
  const quotaStart = quotaModule.indexOf("export function overQuotaDetail");
  assert.ok(quotaStart > 0, "overQuotaDetail moved");
  const template = flat(
    quotaModule
      .slice(quotaStart, quotaModule.indexOf("\n}", quotaStart))
      .split("`")
      .filter((_, i) => i % 2 === 1)
      .join(""),
  ).split("${quota}").join(String(plans().free.explain));
  assert.ok(
    prose(pages.explain).includes(template),
    "/docs/explain quotes an over-quota refusal the product does not send",
  );

  // The third refusal (D558): an incident whose window holds nothing to read.
  // Read from the swept directory's prompt module, where it lives so the D206
  // wording mirror reads it too.
  const noEvidence = repo("apps/web/src/server/explain/incident-prompt.ts");
  const evidenceStart = noEvidence.indexOf("export const NO_EVIDENCE_DETAIL =");
  assert.ok(evidenceStart > 0, "NO_EVIDENCE_DETAIL moved");
  const evidenceDetail = flat(
    noEvidence
      .slice(evidenceStart, noEvidence.indexOf(";", evidenceStart))
      .split('"')
      .filter((_, i) => i % 2 === 1)
      .join(""),
  );
  assert.ok(
    prose(pages.explain).includes(evidenceDetail),
    "/docs/explain quotes a no-evidence refusal the product does not send",
  );
});

test("the docs state that an incident's RCA spends the same Explain allowance (D555)", () => {
  // The one customer consequence of "same counter, no migration": a workspace
  // that runs twenty RCAs has no Explain runs left for traces that month. Said
  // once in the docs, inside the section about metering — not as a footnote
  // somewhere a reader of that section would never see.
  const start = pages.explain.indexOf("## Runs are metered");
  const end = pages.explain.indexOf("## The three refusals");
  assert.ok(start > 0 && end > start, "/docs/explain lost its metering or refusals section");
  assert.ok(
    flat(pages.explain.slice(start, end)).includes(
      "An incident's root-cause analysis is an Explain run too, counted against the same monthly allowance.",
    ),
    "/docs/explain's metering section no longer says an RCA draws on the same allowance",
  );
});

test("the retention constants are retention.go's and migration 0004's", () => {
  const go = repo("services/ingest/internal/retention/retention.go");
  const interval = go.match(/sweepInterval = (\d+) \* time\.Hour/);
  assert.ok(interval, "retention.go no longer states a sweep interval in hours");
  const ttl = repo("services/ingest/migrations/0004_retention_outer_ttl.sql").match(
    /INTERVAL (\d+) DAY/,
  );
  assert.ok(ttl, "migration 0004 no longer sets a day-based outer TTL");

  const flatPage = flat(pages.retention);
  assert.ok(
    flatPage.includes(`every ${interval[1]} hours`),
    `/docs/retention does not state the ${interval[1]}-hour sweep cadence`,
  );
  assert.ok(
    flatPage.includes(`**${ttl[1]}-day TTL**`),
    `/docs/retention does not state the ${ttl[1]}-day outer TTL`,
  );
  assert.ok(
    flat(pages.absences).includes(`${ttl[1]}-day table TTL`),
    `/docs/what-obstack-does-not-do does not state the ${ttl[1]}-day outer bound`,
  );
});

// S7.4 (D528(ii)): incidents are the first authored object the product keeps
// PAST the plan window — the sweep never touches the table, because a
// postmortem a person typed is not telemetry — so the page that opens "Your
// plan's `retention_days` is what obstack keeps" gained the sentence that says
// so, as a flip GATE and not a docs afterthought (the S7.2 lesson, applied to
// a second artifact). This pin couples the sentence to the sweeper: the docs
// may say "never touches" only while `pgDeletes` names no incidents statement.
test("D528(ii): /docs/retention states that incidents outlive the plan window unswept, and retention.go agrees", () => {
  const flatPage = flat(pages.retention);
  assert.ok(
    flatPage.includes("Incidents you write are kept until you delete them"),
    "/docs/retention no longer says incidents are kept until deleted — the first authored object kept past the plan window",
  );
  for (const evidence of ["alert events", "change events", "error traces"]) {
    assert.ok(flatPage.includes(evidence), `/docs/retention no longer names ${evidence} as evidence that still ages out on the plan's window`);
  }
  const go = repo("services/ingest/internal/retention/retention.go");
  const start = go.indexOf("var pgDeletes");
  assert.ok(start > 0, "retention.go no longer declares pgDeletes");
  const block = go.slice(start, go.indexOf("\n}\n", start));
  for (const table of ["alert_events", "change_events"]) {
    assert.ok(block.includes(table), `pgDeletes no longer names ${table} — the block this pin reads was not found`);
  }
  assert.doesNotMatch(block, /\bincidents\b/, "retention.go's pgDeletes names incidents — /docs/retention's \"never touches\" is now false");
  // The Postgres leg's two numbers are the sweeper's, not the page's: the
  // page states the batch and the timeout, and this reads them from the source
  // the way the constants test above reads the interval and the TTL.
  const batch = go.match(/pgBatch = (\d+)/);
  const timeout = go.match(/pgStatementTimeout = (\d+) \* time\.Second/);
  assert.ok(batch && timeout, "retention.go no longer states the Postgres batch size and statement timeout");
  assert.ok(
    flatPage.includes(`batches of ${Number(batch[1]).toLocaleString("en-US")} rows`),
    `/docs/retention does not state the ${batch[1]}-row Postgres batch`,
  );
  assert.ok(flatPage.includes(`${timeout[1]}-second timeout`), `/docs/retention does not state the ${timeout[1]}-second Postgres timeout`);
});

// S7.4 (§7.7): nothing coupled the absences page to `live-routes.ts`, so a flip
// that forgot the page left every test green and the docs lying — the S7.2
// recorded defect, and the reason T7 is its own task. This is the coupling:
// the expectation is DERIVED from the registry, so an M6 surface the registry
// says is live-wired may not be listed here as an absence, and the one it says
// is not must be. When S7.5 wires on-call, the second half of this test goes
// red and the paragraph narrows again — by design, that is the whole point.
test("§7.7: the M6 absences follow the live-routes registry — a wired surface is not an absence, the unwired one is", () => {
  const absences = flat(pages.absences);
  assert.equal(isLiveWiredRoute("/app/incidents"), true, "premise: /app/incidents is live-wired (S7.4 T6, D522)");
  assert.ok(
    !absences.includes("no incident management"),
    "/docs/what-obstack-does-not-do still lists incident management as an absence on a live-wired surface",
  );
  assert.ok(
    absences.includes("Incidents are per-workspace objects a person opens"),
    "/docs/what-obstack-does-not-do no longer states what incidents are (S7.4)",
  );
  assert.ok(absences.includes("M6, as it stands after S7.4"), "the M6 marker no longer names the sprint the paragraph is true after");
  assert.equal(isLiveWiredRoute("/app/oncall"), false, "premise: /app/oncall is unwired until S7.5 — when it wires, narrow the paragraph again");
  assert.ok(absences.includes("There are no on-call rotations"), "the page stopped stating the one M6 absence that remains");
  // The status page is fed by nothing in the product (D547's reason: its
  // notices are hand-written MDX), and the clause names both producers a
  // reader would expect to feed it.
  assert.ok(absences.includes("not fed by SLOs or by incidents"), "the status-page clause lost a producer it is deliberately not fed by");
});

// S8.1 (D656): the same coupling for the MCP paragraph — the registry says
// /app/mcp is live-wired, so "there is no MCP server" may not be an absence,
// and the two things the sprint deliberately did not ship must still be.
test("D656: the MCP absence follows the live-routes registry — the endpoint is not an absence, the skill and the CLI are", () => {
  const absences = flat(pages.absences);
  assert.equal(isLiveWiredRoute("/app/mcp"), true, "premise: /app/mcp is live-wired (S8.1 T5)");
  assert.ok(!absences.includes("There is no MCP server"), "/docs/what-obstack-does-not-do still lists the MCP server as an absence on a live-wired surface");
  assert.ok(absences.includes("There is no agent skill and no CLI"), "the page stopped stating the two absences S8.1 kept");
  assert.ok(absences.includes("records no call log"), "the page stopped stating that calls are not recorded (D655)");
  assert.ok(absences.includes("read-only"), "the page stopped stating that the endpoint never writes");
});

test("the settings tabs the docs send a reader to are tabs the suite renders", () => {
  // "Settings -> X" is a navigation instruction. A renamed tab makes it an
  // instruction to click something that is not there, and nothing else in the
  // suite would notice the docs still name the old one.
  const suite = readFileSync(
    path.join(WEB_SRC, "components/settings/SettingsSuite.tsx"),
    "utf8",
  );
  const declared = suite.match(/^const tabs = \[(.+)\] as const;$/m);
  assert.ok(declared, "SettingsSuite no longer declares its tab list as one array");
  const names = [...declared[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(names.length > 3, "no settings tabs parsed");
  for (const [file, named] of [
    ["quickstart", "API keys"],
    ["billing-and-plans", "Billing & usage"],
  ] as const) {
    assert.ok(names.includes(named), `settings has no "${named}" tab any more`);
    assert.ok(
      pages[file === "quickstart" ? "quickstart" : "billing"].includes(named),
      `/docs/${file} no longer names the "${named}" tab`,
    );
  }
});

// ---------------------------------------------------------------------------
// Accounts and access (D715)
// ---------------------------------------------------------------------------

/** `{ max: N, windowMs: <expr> }` for one policy in `server/rate-limit.ts`, as numbers. */
function rateLimitPolicy(source: string, name: string): { max: number; windowMinutes: number } {
  const m = new RegExp(`\\b${name}: \\{ max: (\\d+), windowMs: ([\\d* ]+) \\}`).exec(source);
  assert.ok(m, `the ${name} rate-limit policy is no longer in the shape this test reads`);
  const windowMs = m[2].split("*").map((n) => Number(n.trim())).reduce((a, b) => a * b, 1);
  return { max: Number(m[1]), windowMinutes: windowMs / 60_000 };
}

test("D715: the accounts page restates the password bounds, the four rate limits, and the key and invite numbers the code holds", () => {
  const accounts = flat(pages.accounts);

  // The password bounds: ONE definition in `lib/account-types.ts` (the
  // library's documented defaults, which `authConfig()` leaves alone), stated
  // twice on the page — at signup and at change — and once in each vocabulary.
  const types = repo("apps/web/src/lib/account-types.ts");
  const min = /export const PASSWORD_MIN = (\d+);/.exec(types)?.[1];
  const max = /export const PASSWORD_MAX = (\d+);/.exec(types)?.[1];
  assert.ok(min && max, "the password bounds are no longer literals in lib/account-types.ts");
  assert.equal((accounts.match(new RegExp(`${min} to ${max} characters`, "g")) ?? []).length, 2);

  // The four rate limits, from the policy table itself (D339/D713).
  const limits = repo("apps/web/src/server/rate-limit.ts");
  const signup = rateLimitPolicy(limits, "signup");
  const login = rateLimitPolicy(limits, "login");
  const password = rateLimitPolicy(limits, "password");
  const email = rateLimitPolicy(limits, "email");
  assert.equal(signup.windowMinutes, 60);
  assert.equal(email.windowMinutes, 60);
  assert.ok(accounts.includes(`${signup.max} signups an hour and ${login.max} sign-ins every ${login.windowMinutes} minutes`));
  assert.ok(
    accounts.includes(`${password.max} password attempts every ${password.windowMinutes} minutes and ${email.max} email changes an hour`),
  );

  // The revocation window is the settings surface's own sentence.
  const suite = flat(repo("apps/web/src/components/settings/SettingsSuite.tsx"));
  assert.ok(suite.includes("a revoked key stops being accepted within 30 seconds"));
  assert.ok(accounts.includes("a revoked key stops being accepted within 30 seconds"));

  // The invitation lifetime is the library's measured default, recorded where
  // the settings page formats the expiry.
  assert.ok(repo("apps/web/src/app/app/settings/page.tsx").includes("invitations last 48 hours"));
  assert.ok(accounts.includes("it expires 48 hours after it was issued"));

  // The scopes the page names are the DDL's vocabulary, no more and no fewer.
  const ddl = repo("services/ingest/pgmigrations/0014_api_key_scope.sql");
  const scopes = /CHECK \(scope IN \(([^)]+)\)\)/.exec(ddl)?.[1]?.match(/'(\w+)'/g)?.map((s) => s.replace(/'/g, ""));
  assert.deepEqual(scopes, ["ingest", "read", "setup"]);
  for (const scope of scopes ?? []) assert.ok(accounts.includes(`\`${scope}\``), `the page stopped naming the ${scope} scope`);
});

test("D715: the account absences follow the code — what the config lacks is what the page says is absent", () => {
  const absences = flat(pages.absences);
  const auth = repo("apps/web/src/server/auth.ts");
  const accounts = flat(pages.accounts);

  // No reset link can exist without a sender, and the config names none.
  assert.ok(!auth.includes("sendResetPassword"), "premise: authConfig() configures no reset-password sender");
  assert.ok(absences.includes("There is no password reset."));
  assert.ok(accounts.includes("obstack sends no email of any kind"));

  // Never verified: the flag is false and no verification sender exists.
  assert.ok(auth.includes("requireEmailVerification: false"));
  assert.ok(!auth.includes("sendVerificationEmail"));
  assert.ok(absences.includes("Email addresses are never verified"));

  // No deletion: the `user.deleteUser` OPTION is never set (the word itself
  // names signup's compensating delete, which is a different thing), so the
  // library answers NOT_FOUND on `/delete-user` before the allowlist refuses it.
  assert.ok(!/deleteUser:\s*\{/.test(auth));
  assert.ok(absences.includes("There is no account deletion and no organization deletion in the product"));

  // One workspace per account (D228): the resolution is owner-pinned and the
  // page says so in the same words the invite surface uses.
  assert.ok(repo("apps/web/src/server/session.ts").includes("m.role = 'owner'"));
  assert.ok(absences.includes("One workspace per account, and no switcher"));
  assert.ok(accounts.includes("there is no workspace switcher"));

  // And the account page is not an absence: it is live-wired, and the page
  // that lists absences does not list it.
  assert.equal(isLiveWiredRoute("/app/account"), true);
  assert.ok(!absences.includes("no account page"));
});

// ---------------------------------------------------------------------------
// The corpus as a whole
// ---------------------------------------------------------------------------

test("every page is registered, and every registered page is written", () => {
  // `docs.test.ts` owns the manifest↔tree mirror. This is the other half: a
  // page that is still the placeholder T1 left behind is registered, walked,
  // built and served, and says nothing.
  assert.equal(corpus.length, 17, "the corpus changed size — update this count deliberately"); // S8.1 T5: +/docs/mcp; D715: +/docs/accounts-and-access
  for (const p of corpus) {
    assert.equal(
      p.source.includes("This page is written in T2"),
      false,
      `${p.file} is still a placeholder`,
    );
    assert.ok(p.source.length > 400, `${p.file} is too short to be a page`);
  }
});

test("no page carries a stale sentence the sources have already corrected", () => {
  // CS5: sentences that are false on master TODAY and would be false in the
  // docs the moment they were copied across.
  for (const stale of [
    "This repo contains **Phase 0**",
    "Phase 0, the frontend prototype",
    "The real number returns with the first runner",
    "Loopwork",
  ]) {
    for (const p of corpus) {
      assert.equal(p.source.includes(stale), false, `${p.file} copied a stale sentence: ${stale}`);
    }
  }
});
