import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// run with: npm test --workspace apps/web
//
// THE fence over the public marketing surface (D257's critical item; S1 L2).
//
// Until this file existed, NOTHING in the suite read `app/page.tsx`. The
// landing page is the largest single surface this product shows a stranger and
// it was the only one with no test at all: the enumeration behind S4.4 walked
// it and found 40 false claims, four of which the suite already banned in other
// files and one of which a test was actively allowlisting. Every repair those
// 40 rows produced is a string, and a string with no test on it is a string
// that comes back.
//
// Text, not import: the page is a Server Component that imports `next/link` and
// `lucide-react`, both of which call `createContext` at module scope, and this
// runner is pinned to `--conditions react-server`, where React has none
// (D54(ii)). So the sources are read as text and mirrored against the files
// that decide them — the `server/ingest-endpoint.test.ts` / D206 shape, one
// direction per check:
//
//   (a) pricing        page numbers  <->  the plans seed in Postgres migrations
//   (b) banned phrases page + components  ->  EMPTY allowlist
//   (c) sample labels  fabricated content  ->  the one SAMPLE_COPY definition
//   (d) connectors     the breadth sentence  <->  connectors.ts
//   (e) links          every href  ->  a route or an anchor that exists
//   (f) screenshots    public/shots/*.png  <->  a content-hash manifest
//
// D246 discipline: the banned phrases are BUILT FROM PARTS below, never spelled
// out. This file is inside the tree that `TourGuide.test.ts` sweeps, and a
// needle written whole would match itself there.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = HERE;
const WEB = path.resolve(HERE, "../..");
const REPO_ROOT = path.resolve(WEB, "../..");
const MARKETING = path.join(WEB, "src/components/marketing");
const SHOTS = path.join(WEB, "public/shots");

const read = (file: string) => readFileSync(file, "utf8");
const PAGE = read(path.join(APP, "page.tsx"));
const LOGIN = read(path.join(APP, "login/page.tsx"));
const SIGNUP = read(path.join(APP, "signup/page.tsx"));
const CONNECTORS = read(path.join(WEB, "src/components/connections/connectors.ts"));
const SCREENS = read(path.join(MARKETING, "ScreensShowcase.tsx"));

/** Every marketing component, by name, so a new one joins the checks by existing. */
const marketingFiles = readdirSync(MARKETING)
  .filter((f) => /\.tsx?$/.test(f) && !f.endsWith(".test.ts") && !f.endsWith(".test.tsx"))
  .sort();

// ─────────────────────────────────────────────────────────── (a) the pricing mirror

/**
 * The seed is the product's own answer to "what does a plan include", and the
 * landing restates it by hand (D226: the page stays copy rather than reaching
 * across the D106 fence into Postgres at render). Restating by hand is exactly
 * what drifts, so both sides are parsed and compared as NUMBERS — the page's
 * "50k" is asserted to expand to the seed's 50000 rather than to look like it.
 */
interface PlanNumbers {
  events: number;
  retentionDays: number;
  explainRuns: number;
  priceUsd: number;
}

function seedPlans(): { Free: PlanNumbers; Pro: PlanNumbers } {
  const metering = read(path.join(REPO_ROOT, "services/ingest/pgmigrations/0005_metering.sql"));
  const quota = read(path.join(REPO_ROOT, "services/ingest/pgmigrations/0006_explain_quota.sql"));

  const row = (id: string, name: string) => {
    const m = new RegExp(`\\('${id}',\\s*'${name}',\\s*(\\d+),\\s*(\\d+),\\s*(\\d+)\\)`).exec(metering);
    assert.ok(m, `the plans seed no longer carries a ${name} row in the shape this test reads`);
    return { events: Number(m[1]), retentionDays: Number(m[2]), priceUsd: Number(m[3]) };
  };
  const explain = /explain_quota = CASE id WHEN 'free' THEN (\d+) WHEN 'pro' THEN (\d+) END/.exec(quota);
  assert.ok(explain, "the Explain quota seed no longer carries both plans in the shape this test reads");

  return {
    Free: { ...row("free", "Free"), explainRuns: Number(explain[1]) },
    Pro: { ...row("pro", "Pro"), explainRuns: Number(explain[2]) },
  };
}

/** The tier object literal in the page's pricing array, as raw text. */
function tierBlock(name: string): string {
  const start = PAGE.indexOf(`name: "${name}",`);
  assert.ok(start > 0, `the pricing block no longer has a ${name} tier`);
  const end = PAGE.indexOf("},", start);
  assert.ok(end > start, `the ${name} tier object never closes`);
  return PAGE.slice(start, end);
}

const stringsIn = (block: string) => [...block.matchAll(/"([^"]*)"/g)].map((m) => m[1]);

/** "50k" -> 50000, "1M" -> 1000000, "200" -> 200. The page's formatting, undone. */
function expand(text: string): number {
  const m = /^(\d+(?:\.\d+)?)([kM]?)$/.exec(text);
  assert.ok(m, `"${text}" is not a number the pricing block formats`);
  const scale = m[2] === "M" ? 1_000_000 : m[2] === "k" ? 1_000 : 1;
  return Number(m[1]) * scale;
}

function pagePlan(name: string): PlanNumbers {
  const block = tierBlock(name);
  const items = stringsIn(block);
  const find = (re: RegExp) => {
    const hit = items.map((i) => re.exec(i)).find(Boolean);
    assert.ok(hit, `the ${name} tier has no item matching ${re}`);
    return hit![1];
  };
  const price = /price: "\$(\d+)"/.exec(block);
  assert.ok(price, `the ${name} tier's price is no longer a dollar figure`);
  return {
    events: expand(find(/^([\d.]+[kM]?) events/)),
    retentionDays: Number(find(/^(\d+)-day retention$/)),
    explainRuns: Number(find(/^(\d+) Explain runs\/mo$/)),
    priceUsd: Number(price[1]),
  };
}

test("(a) the two priced tiers restate the plans seed, number for number", () => {
  const seed = seedPlans();
  // Both directions in one assertion: a page number that drifts fails, and so
  // does a seed that changes without the page following it.
  assert.deepEqual(pagePlan("Free"), seed.Free, "the Free tier no longer matches the plans seed");
  assert.deepEqual(pagePlan("Pro"), seed.Pro, "the Pro tier no longer matches the plans seed");

  // The falsification: the parse must be capable of disagreeing. If either side
  // stopped being read, both would be `{}` and deepEqual would pass on nothing.
  assert.ok(seed.Free.events > 0 && seed.Pro.events > seed.Free.events, "the seed parse returned nothing usable");
});

test("(a) Scale quotes no number, because the seed has no Scale row", () => {
  // Free and Pro are rows in `plans`; Scale is intent with nothing behind it
  // (D229). A tier with no catalog row may not carry a figure a customer could
  // hold anyone to — not an event count, not a retention window, not a price.
  // Comments stripped first: a decision ledger reference is not a quoted
  // figure, and the rule is about what the tier RENDERS.
  const block = tierBlock("Scale").replace(/\/\/[^\n]*/g, "");
  assert.ok(!/\d/.test(block), `the Scale tier quotes a figure it has nothing behind: ${block}`);
  assert.ok(block.includes('price: "Planned"'), "Scale stopped saying its price is planned");

  // And the seed really does lack it, which is the reason for the rule above.
  const metering = read(path.join(REPO_ROOT, "services/ingest/pgmigrations/0005_metering.sql"));
  assert.ok(!/'scale'/i.test(metering), "the plans seed grew a Scale row — the tier can now carry numbers");
});

// ────────────────────────────────────────────────────── (b) the banned-phrase sweep

/**
 * Each needle is assembled from parts. Spelling one out would plant it in the
 * tree `TourGuide.test.ts` sweeps and — for the phrases this file itself hunts
 * — would be a claim living inside its own guard (S2.2 L4).
 *
 * What they are and why each is banned:
 *  1-2. the exporter needs three settings, not one (`connectors.ts:83`)
 *  3.   the demo is a fixed sample corpus; the only live thing is the process
 *  4.   D48 removed the tail from the product; D60 swept the copy
 *  5.   the hero trace is `mock/stories.ts`, not an incident that happened
 *  6.   cluster events are set by `mock/generate.ts` and by no real adapter
 *  7.   self-hosting is a compose file over four services
 *  8-9. there is no hosted obstack, so there is nothing to preview or queue for
 *  10.  there is no SLO product (D256)
 *  11.  no support commitment exists to sell
 */
const BANNED: string[] = [
  ["one", "env", "var"].join(" "),
  ["one", "environment", "variable"].join(" "),
  ["live", "demo"].join(" "),
  ["live", "tail"].join(" "),
  ["real", "failure"].join(" "),
  ["k8s", "events"].join(" "),
  ["one", "container", "to", "self-host"].join(" "),
  ["private", "preview"].join(" "),
  ["wait", "list"].join(""),
  ["powered", "by", "obstack", "slos"].join(" "),
  ["priority", "support"].join(" "),
];

/**
 * EMPTY, and it stays empty. The one allowlist this repo ever kept
 * (`TourGuide.test.ts`) pinned a false claim in place for three sprints — an
 * exception list is a promise to fix something later, and later is when the
 * page is public.
 */
const ALLOWED: string[] = [];

test("(b) the public marketing surface makes none of the claims the product cannot keep", () => {
  const sources: [string, string][] = [
    ["app/page.tsx", PAGE],
    ["app/login/page.tsx", LOGIN],
    ["app/signup/page.tsx", SIGNUP],
    ...marketingFiles.map(
      (f) => [`components/marketing/${f}`, read(path.join(MARKETING, f))] as [string, string],
    ),
  ];
  // The sweep has to have read something before its silence means anything
  // (S2.0 L1): the landing's three pages plus every marketing component.
  assert.ok(sources.length >= 6, `the sweep only found ${sources.length} sources`);

  // Folded once, by one function, used by the sweep AND by the proof below —
  // an inline `.toLowerCase()` at each call site would let the proof pass while
  // the sweep had stopped folding (the R1 finding on TourGuide.test.ts).
  const foldedHits = (text: string) => BANNED.filter((needle) => text.toLowerCase().includes(needle));

  const hits = sources
    .flatMap(([name, text]) => foldedHits(text).map((needle) => `${name}: ${needle}`))
    .sort();
  assert.deepEqual(hits, [...ALLOWED].sort(), "a claim the product cannot keep is back on a public page");

  // The fold is load-bearing and the allowlist is empty, so the proof that the
  // sweep works has to be built rather than found: UI copy arrives Title-Cased
  // and a raw sweep would miss every heading.
  for (const needle of BANNED) {
    const shouted = `## ${needle.toUpperCase()} — the way UI copy actually gets written`;
    assert.deepEqual(foldedHits(shouted), [needle], "the sweep stopped folding case");
    assert.deepEqual(BANNED.filter((n) => shouted.includes(n)), [], "the needles are no longer lower-case");
  }
});

// ────────────────────────────────────────────── (c) the sample-label invariant

/**
 * The rule that replaced the footer line (D326/K9, the fence's §6 finding).
 *
 * `page.tsx:547` used to read "prototype — all data on this site is fictional"
 * and was the ONLY thing on the page saying so — over the hero trace, the hero
 * video and four screenshots at once. It could not simply be deleted, and it
 * could not simply be kept; so it went, and this took its place: fabricated
 * content on this surface has to carry its own label, and "fabricated" is
 * detected structurally rather than trusted.
 *
 * Three triggers, because there are three ways to put invented pixels on this
 * page: import the mock corpus, reference a screenshot, or embed the sting.
 * `page.tsx` trips the third — it renders the video — which is why it must
 * import the constant even though it imports no mock module itself.
 */
const TRIGGERS: [string, (src: string) => boolean][] = [
  ["imports the mock corpus", (s) => s.includes("@/mock/")],
  ["references a screenshot", (s) => s.includes("/shots/")],
  ["embeds the sting", (s) => s.includes(".mp4")],
];

test("(c) every file that renders fabricated content imports the one label", () => {
  const sources: [string, string][] = [
    ["app/page.tsx", PAGE],
    ...marketingFiles.map(
      (f) => [`components/marketing/${f}`, read(path.join(MARKETING, f))] as [string, string],
    ),
  ];

  const IMPORTS_LABEL = /import\s*\{[^}]*\bSAMPLE_COPY\b[^}]*\}\s*from\s*["'][^"']*sample-copy["']/;
  const DEFINES_LABEL = /export const SAMPLE_COPY\s*=/;
  const tripped: string[] = [];
  for (const [name, src] of sources) {
    // The module that DEFINES the label names all three triggers in its own
    // docblock, which is documentation rather than rendered content — and it
    // cannot import itself. Its contract is asserted below instead.
    if (DEFINES_LABEL.test(src)) continue;
    const why = TRIGGERS.filter(([, test]) => test(src)).map(([reason]) => reason);
    if (why.length === 0) continue;
    tripped.push(name);
    assert.match(
      src,
      IMPORTS_LABEL,
      `${name} ${why.join(" and ")} but never imports SAMPLE_COPY — fabricated content with no label on it`,
    );
  }

  // Not vacuous: the three surfaces the removed footer line used to cover.
  assert.deepEqual(
    tripped.sort(),
    ["app/page.tsx", "components/marketing/HeroTrace.tsx", "components/marketing/ScreensShowcase.tsx"],
    "the set of fabricated surfaces changed — every one of them owes a label",
  );

  // One definition, and it is the sentence the app shell has always used.
  const definition = read(path.join(MARKETING, "sample-copy.ts"));
  const value = /export const SAMPLE_COPY = "([^"]+)";/.exec(definition);
  assert.ok(value, "SAMPLE_COPY is no longer a single string literal");
  assert.equal(value[1], "sample data from a fictional company");

  // And the footer line it replaced is gone, which is the whole trade.
  assert.ok(
    !/all data on this site is fictional/.test(PAGE),
    "the blanket footer label is back — the per-surface labels are what replaced it",
  );
});

// ────────────────────────────────────────────── (d) the connector-breadth mirror

interface ConnectorRow {
  slug: string;
  name: string;
  status: string;
}

function connectorRows(): ConnectorRow[] {
  const rows = [...CONNECTORS.matchAll(
    /slug:\s*"([^"]+)",\s*\n\s*name:\s*"([^"]+)",\s*\n\s*category:\s*"[^"]+",\s*\n\s*status:\s*"(available|coming-soon)"/g,
  )].map((m) => ({ slug: m[1], name: m[2], status: m[3] }));
  assert.ok(rows.length > 0, "the connector catalog is no longer in the shape this test reads");
  return rows;
}

test("(d) the breadth sentence names exactly the connectors that are available", () => {
  const rows = connectorRows();
  const available = rows.filter((r) => r.status === "available");
  const comingSoon = rows.filter((r) => r.status === "coming-soon");

  // The catalog, as `connectors.test.ts` also pins it: three of nineteen.
  assert.equal(rows.length, 19, "the connector catalog changed size");
  assert.equal(available.length, 3, "the number of available connectors changed — the breadth sentence must follow");
  assert.equal(comingSoon.length, 16);

  // The sentence, wherever it is written. It is one string used twice — the
  // connections wall and the showcase blurb — so it is found by its tail rather
  // than by a line number.
  const TAIL = "the rest of the catalog is listed as coming soon";
  const sentences = [...PAGE.matchAll(/"([^"]*)"/g), ...SCREENS.matchAll(/"([^"]*)"/g)]
    .map((m) => m[1])
    .filter((s) => s.includes(TAIL));
  assert.equal(sentences.length, 2, "the breadth sentence is not in both the connections wall and the showcase");
  assert.equal(new Set(sentences).size, 1, "the two copies of the breadth sentence have drifted apart");

  const sentence = sentences[0];
  // The bare product name: the catalog spells one of them "OpenTelemetry (OTLP)".
  const bare = (name: string) => name.replace(/\s*\(.*\)\s*$/, "");
  for (const c of available) {
    assert.ok(
      sentence.includes(bare(c.name)),
      `${c.name} is available and the breadth sentence does not name it: "${sentence}"`,
    );
  }
  for (const c of comingSoon) {
    assert.ok(
      !sentence.includes(bare(c.name)),
      `${c.name} is not available and the breadth sentence names it: "${sentence}"`,
    );
  }
});

// ──────────────────────────────────────────────────────────── (e) the link set

type Route = { pattern: string; catchAll: boolean };

function collectRoutes(dir: string, prefix: string, out: Route[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isFile()) {
      if (entry.name === "page.tsx") out.push({ pattern: prefix === "" ? "/" : prefix, catchAll: false });
      continue;
    }
    if (!entry.isDirectory() || entry.name.startsWith("_")) continue;
    if (/^\[\[?\.\.\..+\]\]?$/.test(entry.name)) {
      // A catch-all mounts at its PARENT and swallows everything below it.
      if (existsSync(path.join(full, "page.tsx"))) {
        out.push({ pattern: prefix === "" ? "/" : prefix, catchAll: true });
      }
      continue;
    }
    // `[id]` matches exactly one segment, whatever it holds.
    collectRoutes(full, `${prefix}/${/^\[.+\]$/.test(entry.name) ? ":seg" : entry.name}`, out);
  }
}

function makeResolver(routes: Route[]) {
  const split = (p: string) => p.split("/").filter(Boolean);
  return (href: string) => {
    const segs = split(href.split(/[?#]/)[0]);
    return routes.some((r) => {
      const pat = split(r.pattern);
      if (r.catchAll ? segs.length < pat.length : segs.length !== pat.length) return false;
      return pat.every((s, i) => s === ":seg" || s === segs[i]);
    });
  };
}

test("(e) every link on the three public pages leads somewhere that exists", () => {
  const routes: Route[] = [];
  collectRoutes(APP, "", routes);
  assert.ok(routes.length > 20, `route discovery found only ${routes.length} routes`);
  const resolves = makeResolver(routes);

  // The falsification, before the sweep leans on it: a path with no route
  // behind it must NOT resolve, or "every link resolves" is a tautology.
  assert.equal(resolves("/no-such-route-exists"), false, "the resolver accepts anything");
  assert.equal(resolves("/"), true, "the resolver cannot find the landing page itself");

  const pages: [string, string][] = [
    ["app/page.tsx", PAGE],
    ["app/login/page.tsx", LOGIN],
    ["app/signup/page.tsx", SIGNUP],
  ];

  let checked = 0;
  for (const [name, src] of pages) {
    const hrefs = [
      // A plain literal, and the D329 cross-host wrapper — which prefixes an
      // origin onto a path that must still resolve in a same-host build.
      ...[...src.matchAll(/href="([^"]+)"/g)].map((m) => m[1]),
      ...[...src.matchAll(/href=\{appHref\("([^"]+)"\)\}/g)].map((m) => m[1]),
    ];
    assert.ok(hrefs.length > 0, `${name} renders no links at all`);
    for (const href of hrefs) {
      checked += 1;
      assert.ok(!href.startsWith("#") || href.length > 1, `${name} has an empty anchor`);
      if (href.startsWith("#")) {
        // An in-page anchor: the id has to be in the SAME file, because that is
        // the only page the browser will look at.
        assert.ok(
          src.includes(`id="${href.slice(1)}"`),
          `${name} links to ${href} and nothing on that page carries the id`,
        );
      } else {
        assert.ok(href.startsWith("/"), `${name} links to ${href} — the public pages have no external links`);
        assert.ok(resolves(href), `${name} links to ${href}, which is not a route in this build`);
      }
    }
  }
  assert.ok(checked >= 12, `only ${checked} links were checked — the extraction is missing some`);
});

// ────────────────────────────────────────────────────── (f) the image manifest

interface ShotManifestEntry {
  file: string;
  sha256: string;
  width: number;
  height: number;
  capturedAt: string;
  commit: string;
}

/** Width and height straight out of the IHDR chunk — no decoder needed. */
function pngSize(buf: Buffer): { width: number; height: number } {
  assert.equal(buf.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "not a PNG");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

test("(f) every screenshot is the one the manifest pins, at the size it records", () => {
  // Why a manifest at all: no text sweep can read a PNG. The four shots this
  // replaces were taken two weeks before four of the claims in them were banned
  // in source, and they outlived every copy fix precisely because nothing could
  // see them. A content hash makes a stale screenshot a red test and a re-shoot
  // a deliberate diff.
  const manifest = JSON.parse(read(path.join(SHOTS, "manifest.json"))) as ShotManifestEntry[];
  const onDisk = readdirSync(SHOTS).filter((f) => f.endsWith(".png")).sort();

  assert.deepEqual(
    manifest.map((e) => e.file).sort(),
    onDisk,
    "the manifest and public/shots/ disagree about which screenshots exist",
  );
  assert.ok(onDisk.length >= 4, `only ${onDisk.length} screenshots — the showcase shows four`);

  for (const entry of manifest) {
    const buf = readFileSync(path.join(SHOTS, entry.file));
    assert.equal(
      createHash("sha256").update(buf).digest("hex"),
      entry.sha256,
      `${entry.file} is not the image the manifest pins — re-shoot it and update the manifest, or restore it`,
    );
    assert.deepEqual(
      pngSize(buf),
      { width: entry.width, height: entry.height },
      `${entry.file} is not the size the manifest records`,
    );
    // The provenance a reader needs to judge the pixels: when, and from what.
    assert.match(entry.capturedAt, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/, `${entry.file}: capturedAt is not an instant`);
    assert.match(entry.commit, /^[0-9a-f]{7,40}$/, `${entry.file}: commit is not a revision`);
  }

  // The other direction: an image the showcase renders and the manifest never
  // heard of would be an unpinned claim on the page.
  const rendered = [...SCREENS.matchAll(/"(\/shots\/[^"]+\.png)"/g)].map((m) => path.basename(m[1])).sort();
  assert.equal(rendered.length, 4, "the showcase no longer renders four screenshots");
  for (const file of rendered) {
    assert.ok(
      manifest.some((e) => e.file === file),
      `the showcase renders ${file} and the manifest does not pin it`,
    );
  }
});
