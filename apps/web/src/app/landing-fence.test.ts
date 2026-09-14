import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { docsStaticParams } from "@/lib/docs/docs";

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
//   (b) banned claims  five public surfaces' sources  ->  EMPTY allowlist
//   (b') banned claims  every PRERENDERED page of them  ->  the same allowlist
//   (b'') coverage     every page `next build` wrote  ->  a declared surface
//   (c) sample labels  fabricated content  ->  the one SAMPLE_COPY definition
//   (d) connectors     the breadth sentence  <->  connectors.ts
//   (e) links          every href  ->  a route the manifest actually serves
//   (f) screenshots    public/shots/*.png  <->  a content-hash manifest
//
// (b)/(b')/(b'') and (e) were widened in S4.4 R3. Both had been written when
// `/` was the only public page and had stayed that way while `/docs` (14
// pages), `/status` and `/changelog` shipped public in this sprint: the claim
// sweep read three `.html` files out of 58, and the link resolver accepted any
// path at any depth under the docs catch-all. Each is now derived from the
// thing that decides it — the build output, and the docs manifest.
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

// ──────────────────────────────── (b) the banned-claims registry, per surface

/**
 * ONE registry (S4.4 R3 finding 2), replacing five lists that could not see
 * each other.
 *
 * WHAT WENT WRONG. This check began as a hardcoded array swept over `/`, and
 * four more arrays grew beside it — `status.test.ts`, `mock/corpus-honesty.
 * test.ts`, `shell/TourGuide.test.ts`, `mock/connectors.test.ts` — each with
 * its own inputs and its own idea of whether to fold case. Then S4.4 made
 * `/docs` (14 pages), `/status` and `/changelog` public, and NO list swept
 * them: measured on the build of `067e259`, `.next/server/app` held 58 `.html`
 * files and the rendered arm below read exactly three of them. A banned claim
 * planted in `content/docs/quickstart/index.mdx` left the whole suite green.
 *
 * WHAT REPLACES IT. A claim is a record — the needle, why the product cannot
 * keep it, and the SURFACES it is banned on — and one folded matcher is applied
 * to every surface's sources AND to every page `next build` writes for it. The
 * surfaces are declared once, below, and `(b'') every prerendered page is
 * accounted for` requires the declaration to cover every `.html` in the build:
 * a new public route cannot arrive unswept, which is the exact way this fence
 * fell behind the product.
 *
 * WHY IT LIVES IN THIS FILE and not in a module the other four import. A module
 * exporting the needles would be SHIPPED code carrying every claim this product
 * is banned from making — the D246 problem with no way out — and a test file
 * cannot be imported by another without running its tests twice, which is the
 * reason `mock/corpus-honesty.test.ts:56-67` restates `shell-honesty.test.ts`'s
 * identity list instead of sharing it. So the registry is one list in the file
 * that owns the public surface, the other four keep the narrow lists that name
 * their own subject (a deleted page's vocabulary, a fabricated host, one repo-
 * wide claim), and what R3 removed from them is the DIVERGENCE that mattered:
 * they now fold case the way this file does.
 *
 * D246 DISCIPLINE, unchanged and now load-bearing in a second way: needles are
 * BUILT FROM PARTS. This file is inside the tree `TourGuide.test.ts` sweeps, and
 * the docs surface below sweeps `content/docs/**` — a needle written whole would
 * be a hit on itself. Prose here therefore refers to claims by NUMBER.
 */
type SurfaceId = "landing" | "auth" | "docs" | "status" | "changelog";

/** Every surface a stranger can reach without an account. */
const PUBLIC_SURFACES: readonly SurfaceId[] = ["landing", "auth", "docs", "status", "changelog"];

interface BannedClaim {
  /** Assembled from parts, and lower case: the matcher folds, the needle does not. */
  readonly needle: string;
  /** What the product cannot keep, and the file that decides it. */
  readonly why: string;
  /** Where this claim is banned. */
  readonly surfaces: readonly SurfaceId[];
}

/**
 * D340: the two surfaces whose SOURCE literally carries "an obstack you run
 * yourself" as the unset arm of `appHost()` — `page.tsx` (the hosting
 * sentences at `:162,:550`) and the auth pages (`signup/page.tsx`,
 * `login/page.tsx`, and by the same shape `invite/[id]/page.tsx`, which this
 * registry does not sweep — see `SURFACES` below). Claim 13 exists to catch
 * this stale claim resurfacing on a surface that never had a reason to make
 * it true; banning it on the two surfaces where the flip PUT it there would
 * fail the moment it shipped.
 *
 * THIS SCOPING IS ABOUT SOURCE ONLY. What those two surfaces RENDER depends on
 * the origin the build was given, and on a build that HAS one the phrase is
 * false on exactly them — so `renderedClaimsOn` puts the claim back for (b'),
 * which is the only check that reads the bytes a stranger receives (S4.4
 * retro: a fence over SOURCE files guards the files you edited, not the page).
 */
const HOSTING_ARM_SURFACES: readonly SurfaceId[] = PUBLIC_SURFACES.filter(
  (s) => s !== "landing" && s !== "auth",
);

/**
 * THE claims, and the scope of each.
 *
 * Every one of them is an UNSHIPPED-FEATURE MARKETING CLAIM: a sentence that
 * describes a capability the code does not have. That is why the scope is
 * "every public surface" rather than "the landing page" — the claim does not
 * become true by being made on a docs page, and 8 of the 11 are claims a docs
 * page is MORE likely to make than the landing is (an install line that says
 * one variable, a self-hosting page that says one container, a plans page that
 * sells support). The widening is the point of the registry.
 *
 * `/app/**` is deliberately not among the surfaces — see the block below
 * `IN_APP_OUT_OF_SCOPE`.
 */
const BANNED_CLAIMS: readonly BannedClaim[] = [
  {
    // 1
    needle: ["one", "env", "var"].join(" "),
    why: "the exporter needs three settings, not one (`components/connections/connectors.ts:83`)",
    surfaces: PUBLIC_SURFACES,
  },
  {
    // 2
    needle: ["one", "environment", "variable"].join(" "),
    why: "the same claim, spelled out — `content/docs/sdks/*` is where it comes back",
    surfaces: PUBLIC_SURFACES,
  },
  {
    // 3
    needle: ["live", "demo"].join(" "),
    why: "the demo is a fixed corpus seeded by `src/mock/generate.ts`; the only live thing is the process",
    surfaces: PUBLIC_SURFACES,
  },
  {
    // 4
    needle: ["live", "tail"].join(" "),
    why: "D48 removed the tail from the product; D60 swept the copy — `TourGuide.test.ts` sweeps the whole repo for this one",
    surfaces: PUBLIC_SURFACES,
  },
  {
    // 5
    needle: ["real", "failure"].join(" "),
    why: "the hero trace is `mock/stories.ts`, not an incident that happened",
    surfaces: PUBLIC_SURFACES,
  },
  {
    // 6
    needle: ["k8s", "events"].join(" "),
    why: "cluster events reach `k8sEvents` only through the chart's events collector (Kubernetes deployments, proven by the S4.4 acceptance rider) and never under compose — the public claim comes back qualified and by ruling, not by allowlist; until that ruling it stays banned",
    surfaces: PUBLIC_SURFACES,
  },
  {
    // 7
    needle: ["one", "container", "to", "self-host"].join(" "),
    why: "self-hosting is a compose file over four services — `content/docs/self-hosting/**` is where this one comes back",
    surfaces: PUBLIC_SURFACES,
  },
  {
    // 8
    needle: ["private", "preview"].join(" "),
    why: "nothing is hosted — the only install is `deploy/compose/docker-compose.yml` — so there is nothing to preview, and a changelog entry is where this one would land",
    surfaces: PUBLIC_SURFACES,
  },
  {
    // 9
    needle: ["wait", "list"].join(""),
    why: "nothing to queue for, for the same reason: `deploy/compose/` is the whole product a reader can run",
    surfaces: PUBLIC_SURFACES,
  },
  {
    // 10
    needle: ["powered", "by", "obstack", "slos"].join(" "),
    why: "there is no SLO product (D256) — the deleted `/status` demo's credit line",
    surfaces: PUBLIC_SURFACES,
  },
  {
    // 11
    needle: ["priority", "support"].join(" "),
    why: "no support commitment exists to sell — `content/docs/billing-and-plans` restates the plans",
    surfaces: PUBLIC_SURFACES,
  },
  {
    // 12
    needle: ["host", "obstack", "for", "anyone"].join(" "),
    why: "D340: the hosting negation is DELETED, not rephrased, the moment `app.obstack.dev` exists (D13 outranks the S4.4 landing-is-spec ruling) — banned everywhere, including the auth pages that used to carry it",
    surfaces: PUBLIC_SURFACES,
  },
  {
    // 13
    needle: ["an", "obstack", "you", "run"].join(" "),
    why: "D340: true only on the unset arm of `lib/app-href.ts`'s `appHost()`, which is why the landing and auth SOURCES are excluded above (`HOSTING_ARM_SURFACES`) and why `renderedClaimsOn` puts them back once a build has an origin — everywhere else this is the stale claim the flip retired",
    surfaces: HOSTING_ARM_SURFACES,
  },
];

/**
 * Claim 13 again, identified by the scoping that defines it rather than by its
 * needle (D246: this file may not spell one out). `(b) the registry is a
 * registry` asserts it is the only claim with this scope, so this cannot
 * silently start meaning a different row.
 */
const HOSTING_ARM_CLAIM = BANNED_CLAIMS.find((c) => c.surfaces === HOSTING_ARM_SURFACES)!;

/**
 * A NOTE FOR WHOEVER TRIPS THIS ON A DENIAL. A substring cannot tell a claim
 * from its refutation, so a page that says the product does NOT do claim 6
 * would be red here. That is not a case for an allowlist — see `ALLOWED` — it
 * is a case for writing the absence in the product's own terms, which is what
 * `content/docs/what-obstack-does-not-do` already does for every other one.
 */

/**
 * EMPTY, and it stays empty. The one allowlist this repo ever kept
 * (`TourGuide.test.ts`) pinned a false claim in place for three sprints — an
 * exception list is a promise to fix something later, and later is when the
 * page is public.
 */
const ALLOWED: string[] = [];

/**
 * THE fold, defined ONCE and used by the source sweep, the rendered sweep and
 * the proofs that either works. An inline `.toLowerCase()` per call site is the
 * exact shape of the R1 finding on `TourGuide.test.ts`: the guard folded, the
 * sweep had stopped, and a Title-Cased claim shipped green.
 */
function foldedHits(text: string, claims: readonly BannedClaim[]): string[] {
  const folded = text.toLowerCase();
  return claims.filter((c) => folded.includes(c.needle)).map((c) => c.needle);
}

/** The claims banned on one surface. */
const claimsOn = (surface: SurfaceId) => BANNED_CLAIMS.filter((c) => c.surfaces.includes(surface));

/**
 * WHICH HOSTING ARM A BUILD RENDERED, read out of the artifact rather than out
 * of the environment this process happens to carry: `npm test` is a separate
 * run from `next build` and the env that decided the HTML is long gone by
 * then (D329 — the value is baked at prerender, so the HTML is the only
 * witness). `appHref` writes an ABSOLUTE "Create your workspace" href when
 * `OBSTACK_APP_ORIGIN` was set and a same-host path when it was not, so the
 * CTA the build wrote says which arm every hosting sentence on it is in.
 * Returns the host, or `null` for a single-host build.
 */
function hostedArm(indexHtml: string): string | null {
  const m = /href="(https?:\/\/[^"]*)\/signup"/.exec(indexHtml);
  return m ? new URL(m[1]).host : null;
}

/**
 * The claims banned on one surface's RENDERED bytes, which is not the same
 * list as its sources' (D340).
 *
 * Claim 13's needle is scoped away from `landing`/`auth` because their sources
 * carry it unconditionally — it is the else branch of a ternary, a string
 * literal present in the file whatever the build does with it. On a build with
 * no origin that is also what those pages SAY, and it is true. On a build with
 * one it is false on exactly those two surfaces, and (b') would sweep them
 * with the claim switched off: measured, a landing sentence reverted to the
 * retired copy rendered onto `/` of a mock+origin build and this fence stayed
 * green. So the rendered arm re-adds the claim when the build is hosted.
 */
function renderedClaimsOn(id: SurfaceId, hosted: boolean): readonly BannedClaim[] {
  const claims = claimsOn(id);
  if (!hosted || claims.includes(HOSTING_ARM_CLAIM)) return claims;
  return id === "landing" || id === "auth" ? [...claims, HOSTING_ARM_CLAIM] : claims;
}

// ───────────────────────────────────────────────── the surfaces, declared once

/** Every text file under `dir`, named by its path relative to `src/`. Tests excluded: they assemble needles. */
function textFilesUnder(dir: string, prefix: string): [string, string][] {
  const out: [string, string][] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...textFilesUnder(full, `${prefix}/${entry.name}`));
    else if (/\.(tsx?|mdx|md)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push([`${prefix}/${entry.name}`, read(full)]);
    }
  }
  return out;
}

const PRERENDER = path.join(WEB, ".next/server/app");

/** Every `.html` under `.next/server/app`, relative to it. `[]` when this tree carries no build. */
function prerenderedPages(dir = PRERENDER, prefix = ""): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...prerenderedPages(path.join(dir, entry.name), rel));
    else if (entry.name.endsWith(".html")) out.push(rel);
  }
  return out;
}

interface Surface {
  /** What a reader is looking at, for the failure message. */
  readonly what: string;
  /** The files a person editing this surface touches. */
  readonly sources: () => [string, string][];
  /** The pages `next build` writes for it, relative to `.next/server/app`. */
  readonly pages: () => string[];
}

const SURFACES: Record<SurfaceId, Surface> = {
  landing: {
    what: "`/` — the largest surface this product shows a stranger",
    sources: () => [
      ["app/page.tsx", PAGE],
      ...marketingFiles.map((f) => [`components/marketing/${f}`, read(path.join(MARKETING, f))] as [string, string]),
    ],
    pages: () => ["index.html"],
  },
  auth: {
    what: "`/login` and `/signup` — read before there is an account",
    sources: () => [
      ["app/login/page.tsx", LOGIN],
      ["app/signup/page.tsx", SIGNUP],
    ],
    pages: () => ["login.html", "signup.html"],
  },
  docs: {
    what: "`/docs/**` — the 15 published pages, public since S4.4 T1 (D319/D320); +/docs/mcp in S8.1",
    sources: () => [
      ["app/docs/[[...slug]]/page.tsx", read(path.join(APP, "docs/[[...slug]]/page.tsx"))],
      ...textFilesUnder(path.join(WEB, "src/components/docs"), "components/docs"),
      ...textFilesUnder(path.join(WEB, "src/content/docs"), "content/docs"),
    ],
    pages: () => prerenderedPages().filter((f) => f === "docs.html" || f.startsWith("docs/")),
  },
  status: {
    what: "`/status` — obstack's own status page (D256/D324)",
    sources: () => [
      ["app/status/page.tsx", read(path.join(APP, "status/page.tsx"))],
      ...textFilesUnder(path.join(WEB, "src/content/status"), "content/status"),
    ],
    pages: () => ["status.html"],
  },
  changelog: {
    what: "`/changelog` — the release notes (D323)",
    sources: () => [
      ["app/changelog/page.tsx", read(path.join(APP, "changelog/page.tsx"))],
      ...textFilesUnder(path.join(WEB, "src/content/changelog"), "content/changelog"),
    ],
    pages: () => ["changelog.html"],
  },
};

/**
 * DELIBERATELY OUT OF SCOPE: `/app/**`, the in-app demo screens.
 *
 * D208 rules that demo CONTENT may be invented — those pages ARE a fabricated
 * workspace, labelled as one by `SAMPLE_COPY` and by the tour. The registry
 * above is about what this product CLAIMS to a stranger who has not signed up,
 * and the two are different questions with different answers.
 *
 * ┌─ RESOLVED(coordinator ruling, S4.4 R3) ──────────────────────────────────┐
 * │ Claim 6 also rendered on two in-app pages, and there it was a            │
 * │ CAPABILITY sentence rather than story data — the part D208 does not      │
 * │ cover, since nothing ingests cluster events (`server/adapters.ts` sets   │
 * │ none). Ruling: no capability sentence may make claim 6, and every        │
 * │ instance was removed at source that round —                              │
 * │ `app/app/incidents/page.tsx`, `mock/mcp.ts:17`,                          │
 * │ `components/incidents/IncidentRca.tsx` ×2, `shell/TourGuide.tsx`.        │
 * │                                                                          │
 * │ The needle stays scoped to PUBLIC_SURFACES: D208 continues to cover      │
 * │ in-app story DATA — the demo incident keeps its invented k8s row — and   │
 * │ nothing was allowlisted.                                                 │
 * │                                                                          │
 * │ Since that ruling (S4.4, later): the chart's events collector now ships  │
 * │ cluster events and `server/adapters.ts` sets `k8sEvents` from them —     │
 * │ Kubernetes deployments only, proven by the acceptance rider. The four    │
 * │ removed capability sentences stay removed until a copy ruling names the  │
 * │ qualified claim; their comments say so at each site.                     │
 * └──────────────────────────────────────────────────────────────────────────┘
 */
const IN_APP_OUT_OF_SCOPE = (page: string) => page === "app.html" || page.startsWith("app/");

/** Next's own error pages: no product copy, nothing to claim. */
const FRAMEWORK_PAGES = ["_global-error.html", "_not-found.html"];

// ─────────────────────────────────────────────────── (b) the sweep over sources

test("(b) no public surface makes a claim the product cannot keep — in source", () => {
  const hits: string[] = [];
  let swept = 0;
  for (const id of PUBLIC_SURFACES) {
    const surface = SURFACES[id];
    const sources = surface.sources();
    // A sweep has to have read something before its silence means anything
    // (S2.0 L1), and it has to have read something PER SURFACE — a surface
    // whose directory moved would otherwise contribute zero files and zero
    // hits, which reads exactly like a clean one.
    assert.ok(sources.length > 0, `the ${id} surface (${surface.what}) has no sources — the sweep found nothing to read`);
    swept += sources.length;
    for (const [name, text] of sources) {
      for (const needle of foldedHits(text, claimsOn(id))) hits.push(`${id} ${name}: ${needle}`);
    }
  }
  assert.ok(swept >= 30, `the sweep only read ${swept} files across five surfaces`);
  assert.deepEqual(hits.sort(), [...ALLOWED].sort(), "a claim the product cannot keep is back on a public surface");

  // The fold is load-bearing and the allowlist is empty, so the proof that the
  // sweep works has to be BUILT rather than found: UI copy arrives Title-Cased
  // and a raw sweep would miss every heading.
  for (const claim of BANNED_CLAIMS) {
    const shouted = `## ${claim.needle.toUpperCase()} — the way UI copy actually gets written`;
    assert.deepEqual(foldedHits(shouted, BANNED_CLAIMS), [claim.needle], "the sweep stopped folding case");
    assert.deepEqual(
      BANNED_CLAIMS.filter((c) => shouted.includes(c.needle)).map((c) => c.needle),
      [],
      "the needles are no longer lower-case",
    );
  }
});

test("(b) the registry is a registry — every claim scoped, every surface covered", () => {
  // The scoping is DATA, so it can go wrong quietly: a claim with no surfaces
  // is a rule that runs nowhere, and a surface no claim names is a page the
  // sweep visits and never judges. Both are green without this.
  assert.equal(BANNED_CLAIMS.length, 13);
  assert.equal(new Set(BANNED_CLAIMS.map((c) => c.needle)).size, BANNED_CLAIMS.length, "two claims share a needle");
  // `HOSTING_ARM_CLAIM` identifies claim 13 by this scope, and `(b')` re-adds
  // exactly that claim on a hosted build — a second row sharing the scope
  // would make the identification pick one of them at random.
  assert.equal(
    BANNED_CLAIMS.filter((c) => c.surfaces === HOSTING_ARM_SURFACES).length,
    1,
    "the hosting-arm scope is no longer one claim's — (b') re-adds it by identity",
  );
  for (const claim of BANNED_CLAIMS) {
    assert.ok(claim.surfaces.length > 0, `a claim is banned nowhere: ${claim.why}`);
    assert.ok(claim.why.length > 20, `a claim carries no reason: ${claim.needle}`);
    // The reason has to name something a reader can go and check.
    assert.match(claim.why, /`|D\d+/, `the reason for a claim names no source: ${claim.why}`);
  }
  for (const id of PUBLIC_SURFACES) {
    assert.ok(claimsOn(id).length > 0, `no claim is banned on the ${id} surface`);
  }
  assert.deepEqual(Object.keys(SURFACES).sort(), [...PUBLIC_SURFACES].sort(), "a surface is declared and never swept");
});

// ────────────────────────── (b') the same registry, on the rendered pages

/**
 * HTML entities, undone — in ONE pass, so `&amp;lt;` decodes to `&lt;` and not
 * to `<`. The sweep needs this because the prerenderer escapes as it writes:
 * the phrase that made this arm exist reached the landing page as
 * `pods &amp;#x27;…` — an ampersand the needle does not contain, sitting in the
 * middle of it. A raw `includes` over the HTML would have read straight past
 * the claim it was looking for.
 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};
function decodeEntities(html: string): string {
  return html.replace(/&(?:#x([0-9a-fA-F]+)|#(\d+)|([a-zA-Z]+));/g, (whole, hex, dec, name) => {
    if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
    if (dec) return String.fromCodePoint(Number(dec));
    return NAMED_ENTITIES[String(name).toLowerCase()] ?? whole;
  });
}

/**
 * The build precondition, stated once. `npm test` does not build, so this is a
 * CI ORDERING fact rather than a property of the code: under `CI` a missing
 * `.next` FAILS and says which step has to run first, and locally it skips with
 * the reason stated (S2.0 L1 — a silent skip is how the two arms in `docs/`
 * went a sprint without running). `.github/workflows/web.yml` orders build
 * before test for exactly this reason; if that order is ever undone, these are
 * the reds that say so.
 */
function requireBuild(t: { skip: (why: string) => void }, what: string): boolean {
  if (prerenderedPages().length > 0) return true;
  const why = `no .next/server/app under apps/web — this arm reads ${what}, so \`npm run build\` (apps/web) must run before \`npm test\``;
  assert.ok(!process.env.CI, why);
  t.skip(`${why} — skipped locally, fails on CI`);
  return false;
}

/**
 * WHY THIS ARM EXISTS (R2 must-fix 1).
 *
 * Check (b) reads the files a person editing a surface touches. It cannot read
 * what those files RENDER. `HeroTrace` mounts the product's own `Waterfall` on a
 * mock story, and the waterfall's infra heading is computed in
 * `lib/infra-track.ts` from the story's cluster events: claim 6 was therefore
 * printed onto `/` for a whole sprint, by a module in neither swept directory,
 * while (b) stayed green with an empty allowlist.
 *
 * So the registry is applied to the artifact a stranger actually receives.
 * Anything a page composes — a shared component, a helper, a constant three
 * imports away — is in scope by construction, because the scope is the bytes.
 */
test("(b') no public surface renders one either", (t) => {
  if (!requireBuild(t, "the PRERENDERED public pages")) return;

  // Which arm this build is in, decided by the build itself (D340).
  const index = decodeEntities(read(path.join(PRERENDER, "index.html")));
  const host = hostedArm(index);

  // D354 — the fail-not-skip arm. This process's own env is not what decided
  // the artifact (`npm build` and `npm test` are separate runs, D329), which
  // is exactly why `host` above is read off the HTML rather than trusted from
  // `process.env`. But that same split lets a CI job set OBSTACK_APP_ORIGIN
  // on the TEST step and forget it on the BUILD step — the artifact then has
  // no baked host at all, `host` reads `null`, and every assertion below
  // would quietly run the unset-arm's checks and pass, on a build that was
  // supposed to be hosted (S4.4 L3: a green run that never exercised what it
  // claims to). So when this process's own env carries an origin, the
  // ARTIFACT must carry that same host's baked absolute CTA — not "some
  // host", not "any non-null host", the one this env named.
  const envOrigin = process.env.OBSTACK_APP_ORIGIN?.trim();
  if (envOrigin) {
    const expectedHost = new URL(envOrigin).host;
    assert.equal(
      host,
      expectedHost,
      host === null
        ? `OBSTACK_APP_ORIGIN=${envOrigin} is set on this test process, but \`/\`'s baked CTA has no ` +
            "absolute host at all — the build that produced .next ran without the origin"
        : `OBSTACK_APP_ORIGIN=${envOrigin} is set on this test process, but \`/\`'s baked CTA points at ` +
            `${host} instead — the build and this test disagree about the origin`,
    );
  }

  const hits: string[] = [];
  let read_ = 0;
  for (const id of PUBLIC_SURFACES) {
    const pages = SURFACES[id].pages();
    assert.ok(pages.length > 0, `the ${id} surface prerendered nothing — ${SURFACES[id].what}`);
    for (const page of pages) {
      const file = path.join(PRERENDER, page);
      assert.ok(existsSync(file), `${id}: the build wrote no ${page}`);
      const html = decodeEntities(read(file));
      // Not vacuous: the page has to have been read.
      assert.ok(html.length > 2000, `${page} is too small to be a rendered page`);
      read_ += 1;
      for (const needle of foldedHits(html, renderedClaimsOn(id, host !== null))) hits.push(`${page}: ${needle}`);
    }
  }
  // 1 + 2 + 14 + 1 + 1 — the count is asserted because "swept nothing" and
  // "swept everything cleanly" are the same green.
  assert.ok(read_ >= 19, `only ${read_} rendered pages were swept`);
  assert.deepEqual(hits.sort(), [...ALLOWED].sort(), "a claim the product cannot keep is RENDERED on a public page");

  // The decode is load-bearing rather than decorative, in both of the ways it
  // can quietly stop working. One pass, hex and decimal included — `&amp;amp;`
  // must come back as `&amp;`, not as `&`, or a second-order escape decodes
  // into a phrase nobody wrote.
  assert.equal(decodeEntities("pods &amp; events &#x26; more &#38; &amp;amp;"), "pods & events & more & &amp;");
  // And every needle is words separated by spaces, which is a character UI copy
  // escapes — Title-cased too, so this proves the fold and the decode together.
  const spaced = BANNED_CLAIMS.find((c) => c.needle.includes(" "))!;
  const planted = `<h2 class="x">${spaced.needle.toUpperCase().split(" ").join("&nbsp;")}</h2>`;
  assert.deepEqual(foldedHits(planted, BANNED_CLAIMS), [], "the needle survived escaping — nothing to decode");
  assert.deepEqual(
    foldedHits(decodeEntities(planted), BANNED_CLAIMS),
    [spaced.needle],
    "the decode no longer exposes an escaped claim",
  );

  // And the hosting arm is not vacuous in EITHER direction, which is the only
  // thing standing between the sweep above and a green run over a page that
  // says the wrong one (D340).
  if (host === null) {
    // Unhosted: the sentence the claim would ban is the TRUE one here, and it
    // has to actually be on the page — otherwise a deletion passes as a flip.
    assert.deepEqual(
      foldedHits(index, [HOSTING_ARM_CLAIM]),
      [HOSTING_ARM_CLAIM.needle],
      "the single-host landing no longer says whose obstack a signup lands on",
    );
  } else {
    // Hosted: the prose names the same host the CTA points at, so the ban had
    // a live sentence to be about rather than an absent one.
    assert.ok(index.toLowerCase().includes(`on ${host.toLowerCase()}`), `\`/\` renders no hosting sentence for ${host}, the origin its own CTA points at`);
  }
  // The re-scoping itself, proven on planted text both ways — the real page
  // must never carry the needle, so the proof cannot be found on it.
  const staleSentence = `<p>Signing up creates your workspace ${HOSTING_ARM_CLAIM.needle}.</p>`;
  assert.deepEqual(
    foldedHits(staleSentence, renderedClaimsOn("landing", true)),
    [HOSTING_ARM_CLAIM.needle],
    "a hosted build no longer bans the retired hosting claim on `/`",
  );
  assert.deepEqual(
    foldedHits(staleSentence, renderedClaimsOn("auth", true)),
    [HOSTING_ARM_CLAIM.needle],
    "a hosted build no longer bans the retired hosting claim on the auth pages",
  );
  assert.deepEqual(
    foldedHits(staleSentence, renderedClaimsOn("landing", false)),
    [],
    "a single-host build banned the sentence that is true on it",
  );
});

test("(b'') every prerendered page is accounted for", (t) => {
  if (!requireBuild(t, "the list of pages `next build` wrote")) return;

  // THE assertion that keeps this fence level with the product. Before it,
  // `PUBLIC_HTML` was three filenames typed by hand: `/docs`, `/status` and
  // `/changelog` shipped public in this same sprint and the rendered sweep
  // never learned they existed. A route cannot arrive unswept now — it either
  // belongs to a surface, or it is in-app, or it is a framework page, and
  // anything else is this failure, by name.
  const all = prerenderedPages();
  assert.ok(all.length > 40, `the build wrote only ${all.length} pages — this arm is reading the wrong tree`);

  const swept = new Set(PUBLIC_SURFACES.flatMap((id) => SURFACES[id].pages()));
  const unaccounted = all.filter(
    (page) => !swept.has(page) && !IN_APP_OUT_OF_SCOPE(page) && !FRAMEWORK_PAGES.includes(page),
  );
  assert.deepEqual(
    unaccounted,
    [],
    "a prerendered page belongs to no declared surface — add it to SURFACES (and sweep it), or say why it is out of scope",
  );

  // The partition is a partition: no page claimed twice, and the in-app rule
  // does not quietly swallow a public one.
  const perSurface = PUBLIC_SURFACES.flatMap((id) => SURFACES[id].pages());
  assert.equal(new Set(perSurface).size, perSurface.length, "two surfaces claim the same prerendered page");
  assert.deepEqual(perSurface.filter(IN_APP_OUT_OF_SCOPE), [], "a surface claims an in-app page");
  // And the docs surface really is the whole corpus, not one page of it.
  assert.equal(SURFACES.docs.pages().length, 16, "the docs surface no longer covers all 16 published pages (the index and fifteen)");
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

/**
 * The three shapes a directory name can have under `app/`, told apart exactly
 * (S4.4 R3 finding 1).
 *
 * The old test asked one question — `/^\[\[?\.\.\..+\]\]?$/` — and got three
 * wrong answers for it. `[...slug]` (REQUIRED) was treated as matching its bare
 * parent path, which it does not: a required catch-all needs at least one
 * segment. `[[...slug]` and `[...slug]]`, which are not route segments at all,
 * matched too — a typo in a directory name would have silently mounted a
 * catch-all that swallowed a whole subtree. And `.+` accepted brackets inside
 * the name, which is what let the malformed pair through.
 */
const OPTIONAL_CATCH_ALL = /^\[\[\.\.\.[^[\]]+\]\]$/;
const REQUIRED_CATCH_ALL = /^\[\.\.\.[^[\]]+\]$/;
const DYNAMIC_SEGMENT = /^\[[^[\]]+\]$/;

type Route =
  /** A fixed path, possibly with `:seg` where a `[id]` matches exactly one segment. */
  | { pattern: string; kind: "fixed" }
  /** A catch-all mounted at `pattern`, serving exactly `slugs` beneath it. */
  | { pattern: string; kind: "optional" | "required"; slugs: readonly string[] };

/**
 * WHAT A CATCH-ALL ACTUALLY SERVES — the half the old resolver had no answer
 * for, and the reason check (e) could not fail.
 *
 * `makeResolver` used to accept ANY path at ANY depth under a catch-all, so
 * `/docs/quickstarts`, `/docs/self-hosting/typo` and `/docs/a/b/c/d` all
 * resolved true while the real route HARD-404s every one of them: the public
 * mount sets `dynamicParams = false` (`app/docs/[[...slug]]/page.tsx:29`) and,
 * on both mounts, `loadDoc` calls `notFound()` for a slug the manifest does not
 * carry (`lib/docs/load.ts:91`). A mistyped `/docs/...` link on the landing page
 * was therefore a dead link the fence over the landing page called fine.
 *
 * So the catch-alls are asked the same question the ROUTE asks: the list comes
 * from `docsStaticParams()` — the function both route files hand to
 * `generateStaticParams` — rather than from a second list written here. This is
 * the file's one import (everything else is read as text, because the pages are
 * Server Components this runner cannot load, D54(ii)); `lib/docs/docs.ts` is
 * pure by construction, which is the whole reason D320 split it out of
 * `load.ts`.
 *
 * `""` is in the list because the docs index is `{ slug: undefined }` — the
 * optional catch-all's match on its own base path — so "does `/docs` resolve"
 * and "does `/docs/quickstart` resolve" are one question with one answer.
 */
const docsSlugs = () => docsStaticParams().map((p) => (p.slug ?? []).join("/"));

const CATCH_ALL_SLUGS: Record<string, () => readonly string[]> = {
  "/docs": docsSlugs,
  "/app/docs": docsSlugs,
};

function collectRoutes(dir: string, prefix: string, out: Route[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isFile()) {
      if (entry.name === "page.tsx") out.push({ pattern: prefix === "" ? "/" : prefix, kind: "fixed" });
      continue;
    }
    if (!entry.isDirectory() || entry.name.startsWith("_")) continue;

    if (entry.name.startsWith("[")) {
      const optional = OPTIONAL_CATCH_ALL.test(entry.name);
      const required = REQUIRED_CATCH_ALL.test(entry.name);
      // A malformed segment is a loud failure, not a guess: the whole point of
      // telling the three shapes apart is that the wrong guess is invisible.
      assert.ok(
        optional || required || DYNAMIC_SEGMENT.test(entry.name),
        `app/${path.relative(APP, full)} is not a route segment Next understands — [id], [...slug] or [[...slug]]`,
      );
      if (optional || required) {
        // A catch-all mounts at its PARENT. The OPTIONAL form also answers that
        // parent path with no segments at all; the required form does not.
        if (existsSync(path.join(full, "page.tsx"))) {
          const pattern = prefix === "" ? "/" : prefix;
          const slugs = CATCH_ALL_SLUGS[pattern];
          assert.ok(
            slugs,
            `${pattern} is a catch-all with no entry in CATCH_ALL_SLUGS — without the list its route serves, ` +
              "this resolver would accept any path at any depth below it and check (e) would be a tautology",
          );
          out.push({ pattern, kind: optional ? "optional" : "required", slugs: slugs() });
        }
        continue;
      }
    }
    // `[id]` matches exactly one segment, whatever it holds.
    collectRoutes(full, `${prefix}/${DYNAMIC_SEGMENT.test(entry.name) ? ":seg" : entry.name}`, out);
  }
}

function makeResolver(routes: Route[]) {
  const split = (p: string) => p.split("/").filter(Boolean);
  return (href: string) => {
    const segs = split(href.split(/[?#]/)[0]);
    return routes.some((r) => {
      const pat = split(r.pattern);
      if (r.kind === "fixed") {
        if (segs.length !== pat.length) return false;
        return pat.every((s, i) => s === ":seg" || s === segs[i]);
      }
      // The mount, then the tail — and the tail has to be one this route
      // actually serves, because off-manifest is a 404 and not a page.
      if (segs.length < pat.length) return false;
      if (!pat.every((s, i) => s === ":seg" || s === segs[i])) return false;
      const tail = segs.slice(pat.length).join("/");
      if (tail === "" && r.kind === "required") return false;
      return r.slugs.includes(tail);
    });
  };
}

test("(e) every link on the three public pages leads somewhere that exists", () => {
  const routes: Route[] = [];
  collectRoutes(APP, "", routes);
  assert.ok(routes.length > 20, `route discovery found only ${routes.length} routes`);
  const resolves = makeResolver(routes);

  // Both catch-alls in this app are the docs mounts, and both were discovered:
  // an entry in CATCH_ALL_SLUGS for a route that no longer exists is a list
  // pointed at nothing, and `collectRoutes` already fails the other way round.
  const catchAlls = routes.filter((r) => r.kind !== "fixed").map((r) => r.pattern).sort();
  assert.deepEqual(catchAlls, Object.keys(CATCH_ALL_SLUGS).sort(), "a catch-all route appeared or vanished");

  // The strictness above is only honest because the ROUTE refuses too. Both
  // halves are asserted, because they are the two independent reasons an
  // off-manifest slug 404s and either one alone would be a weaker claim than
  // this resolver makes (D320: the in-app mount renders per request in live
  // mode, so it cannot lean on the prerender manifest).
  assert.match(
    read(path.join(APP, "docs/[[...slug]]/page.tsx")),
    /export const dynamicParams = false;/,
    "the public docs mount no longer refuses off-manifest slugs at the route",
  );
  assert.match(
    read(path.join(WEB, "src/lib/docs/load.ts")),
    /if \(!entry\) notFound\(\);/,
    "loadDoc no longer 404s a slug the manifest does not carry",
  );

  // The falsification, before the sweep leans on it: a path with no route
  // behind it must NOT resolve, or "every link resolves" is a tautology.
  assert.equal(resolves("/no-such-route-exists"), false, "the resolver accepts anything");
  assert.equal(resolves("/"), true, "the resolver cannot find the landing page itself");
  // And under the catch-all, which is where it WAS a tautology. Every one of
  // these returned true before R3; every one of them hard-404s in the build.
  assert.equal(resolves("/docs"), true, "the docs index stopped resolving");
  assert.equal(resolves("/docs/quickstart"), true, "a manifested page stopped resolving");
  assert.equal(resolves("/docs/sdks/typescript"), true, "a nested manifested page stopped resolving");
  assert.equal(resolves("/app/docs/quickstart"), true, "the in-app mount stopped resolving");
  for (const dead of [
    "/docs/quickstarts",
    "/docs/self-hosting/typo",
    "/docs/a/b/c/d",
    "/docs/sdks",
    "/docs/quickstart/extra",
    "/app/docs/quickstarts",
  ]) {
    assert.equal(resolves(dead), false, `${dead} is not a page and the resolver still accepts it`);
  }
  // A fragment or a query on a real page is still that page.
  assert.equal(resolves("/docs/quickstart#send-your-first-trace"), true);
  assert.equal(resolves("/docs?x=1"), true);

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

// ──────────────────────────────────── (g) the label on a link to /app, per image

/**
 * ONE Dockerfile, two images (`apps/web/Dockerfile:42-43`, built both ways by
 * `.github/workflows/images.yml:51-52`), and `/app` is a demo in exactly ONE of
 * them. In the live image an anonymous reader who follows that link is
 * redirected to `/login` (`app/app/layout.tsx`) and a signed-in one lands in
 * their own workspace with their own ingested telemetry in it.
 *
 * So the word is only available to a page that can KNOW which image it is in.
 * `/`, `/docs`, `/status` and `/changelog` cannot: they take no mode branch and
 * ship the same bytes to both, so a link they render must be called the app.
 * `/login` and `/signup` can, and do — their whole demo-facing tree sits inside
 * `dataMode === "mock"` (D150/D157), the one branch that cannot reach the live
 * image, so there the word is earned.
 *
 * WHY THIS ARM EXISTS. The S4.4 enumeration rated the landing's three demo
 * labels TRUE, on the reading its own header records: it walked the public
 * surface "as a stranger sees it on the D262 marketing host" — one of the two
 * images this page ships to. The sibling pages were repaired to the neutral
 * label with the reason written in a comment; a comment is not a fence, and the
 * three labels on the largest surface were left behind by it. This is the check
 * that could have caught both, and it is the check that keeps the four pages
 * saying the same thing as they change.
 *
 * Rendered labels, not a phrase sweep: `app/docs/[[...slug]]/page.tsx:29` states
 * the rule in prose and names the word to do it, which is exactly the sentence a
 * substring sweep would call a violation.
 */

/** The child text of every `<Link href="/app">` in a source, tags and expressions stripped. */
function appLinkLabels(src: string): string[] {
  return [...src.matchAll(/href="\/app"[^>]*>([\s\S]*?)<\/Link>/g)].map((m) =>
    m[1]
      .replace(/<[^>]*>/g, " ")
      .replace(/\{[^}]*\}/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

/** The four public pages that are the same bytes in both images. */
const SINGLE_BUILD_PAGES: readonly [string, string][] = [
  ["app/page.tsx", PAGE],
  ["app/docs/[[...slug]]/page.tsx", read(path.join(APP, "docs/[[...slug]]/page.tsx"))],
  ["app/status/page.tsx", read(path.join(APP, "status/page.tsx"))],
  ["app/changelog/page.tsx", read(path.join(APP, "changelog/page.tsx"))],
];

test("(g) a link to /app is called a demo only where the mode is known", () => {
  // The four that cannot know.
  let labelled = 0;
  for (const [name, src] of SINGLE_BUILD_PAGES) {
    const labels = appLinkLabels(src);
    assert.ok(labels.length > 0, `${name} renders no link to /app — the extraction is reading the wrong shape`);
    labelled += labels.length;
    for (const label of labels) {
      assert.ok(label.length > 0, `${name} renders a link to /app with no label at all`);
      assert.ok(
        !/demo/i.test(label),
        `${name} calls /app a demo ("${label}"), and this page is the same bytes in the live image, ` +
          "where /app is the reader's own workspace behind /login",
      );
    }
  }
  assert.ok(labelled >= 6, `only ${labelled} labels were read across the four pages`);

  // The landing's three, exactly — one in the nav, one in the hero, one in the
  // closing CTA. They are one claim in three places, and the way they went
  // wrong was one of them being repaired alone.
  assert.deepEqual(
    appLinkLabels(PAGE),
    ["Open the app", "Open the app", "Open the app"],
    "the landing's three links to /app no longer carry one label",
  );

  // And the two that CAN know: the word is allowed, and only inside the gate.
  // A rendered test cannot prove this half — `dataMode` resolves once per
  // process — but the source can: the mock branch RETURNS, so everything from
  // the first statement after it belongs to the live image.
  const DEMO = ["Open the", "demo"].join(" ");
  for (const [name, src] of [
    ["app/login/page.tsx", LOGIN],
    ["app/signup/page.tsx", SIGNUP],
  ] as const) {
    const gate = src.indexOf('if (dataMode === "mock") {');
    assert.ok(gate > 0, `${name} no longer gates on the one mode predicate — the word has lost its warrant`);
    const liveBranch = src.indexOf("const message =", gate);
    assert.ok(liveBranch > gate, `${name}'s live branch no longer begins where this test reads it`);

    const at = [...src.matchAll(new RegExp(DEMO, "g"))].map((m) => m.index!);
    assert.equal(at.length, 1, `${name} carries the demo label ${at.length} times`);
    assert.ok(
      at[0] > gate && at[0] < liveBranch,
      `${name} carries the demo label outside the mock branch — the live image would render it`,
    );
    // The label really is on the link, not loose prose beside it.
    assert.deepEqual(appLinkLabels(src), [DEMO], `${name}'s link to /app is not the thing carrying the label`);
  }

  // The falsification, both ways: the extractor has to be able to SEE a label,
  // and the rule has to be able to reject one. Without this the whole arm is
  // green on a regex that matches nothing.
  const planted = '<Link\n  href="/app"\n  className="x"\n>\n  Open the DEMO <ArrowRight className="h-4 w-4" />\n</Link>';
  assert.deepEqual(appLinkLabels(planted), ["Open the DEMO"], "the extractor stopped reading link labels");
  assert.ok(/demo/i.test(appLinkLabels(planted)[0]), "the rule stopped folding case");
});
