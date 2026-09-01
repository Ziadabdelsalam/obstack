import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// run with: npm test --workspace apps/web
//
// The M3 honesty gate over the app shell (S3.5 T5): the chrome a signed-up
// stranger reads on every screen. Four surfaces, one rule — chrome may show
// demo content, but it may not make a claim about the running system or offer
// a door that leads nowhere.
//
// Text, not import: these are all `"use client"` components and the runner is
// pinned to `--conditions react-server`, which cannot load one (D54(ii)) — the
// same reason `TourGuide.test.ts` beside this file reads source.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (file: string) => readFileSync(path.join(HERE, file), "utf8");
const TOP_BAR = read("TopBar.tsx");
const SIDE_NAV = read("SideNav.tsx");
const PALETTE = read("CommandPalette.tsx");
const TOUR = read("TourGuide.tsx");
const BADGE = read("SampleDataBadge.tsx");
const DEMO_FOOTER = read("DemoFooter.tsx");
const LAYOUT = readFileSync(path.join(HERE, "../../app/app/layout.tsx"), "utf8");
const OVERVIEW = readFileSync(path.join(HERE, "../../app/app/page.tsx"), "utf8");

test("TopBar makes no claim about the running system", () => {
  // A throughput reading and a deployment region in the status strip: mock-mode
  // fabrications about the product itself, not demo telemetry. obstack has no
  // regions and the demo ingests nothing.
  for (const claim of ["9.4k", "events/min", "EU-CENTRAL", "ingesting"]) {
    assert.ok(!TOP_BAR.includes(claim), `TopBar claims "${claim}" — the bar carries no system status`);
  }
});

test("F2: the demo's overview status row does not claim the demo is ingesting", () => {
  // The TopBar ban above is a ban on a WORD, and the word was living one
  // component over: `/app`'s own status strip rendered "ingesting ·
  // loopwork-prod · last 6h" on the mock branch — under a footer saying nothing
  // is being ingested, and in the pixels of the landing page's screenshot,
  // where no text sweep could reach it.
  //
  // It is banned on the MOCK branch only. In live mode the row is backed by
  // ingested telemetry and the word is true there, so this reads the mode
  // ternary rather than the file: collapse the two branches into one literal
  // and the parse below fails rather than passing by finding nothing.
  const start = OVERVIEW.indexOf("pulse-dot");
  assert.ok(start > 0, "the overview status strip is gone — this guard reads its mode ternary");
  const strip = OVERVIEW.slice(start, OVERVIEW.indexOf("</div>", start));
  const halves = strip.split(") : (");
  assert.equal(halves.length, 2, "the status strip no longer branches on mode — both halves must be readable");
  const [liveHalf, mockHalf] = halves;
  assert.ok(liveHalf.includes("{data.workspaceId}"), "the live half stopped naming the session's workspace");
  assert.ok(
    !mockHalf.includes("ingesting"),
    "the demo's overview claims it is ingesting — this deployment ingests nothing (D228)",
  );
  assert.ok(mockHalf.trim().length > 10, "the mock half parsed empty — the guard is reading nothing");
});

test("TopBar names a real operator or none at all", () => {
  // The fallback identity was a real person's name and address, labelled owner
  // of an account nobody is signed into.
  //
  // MIRRORED LIST (D235): `src/mock/corpus-honesty.test.ts` bans these same two
  // literals in the mock corpus and pins them against this line. Editing the
  // pair here turns that test red — the moment to edit it there too.
  for (const identity of ["Ziad Abdelsalam", "ziad@loopwork.ai"]) {
    assert.ok(!TOP_BAR.includes(identity), `TopBar still falls back to ${identity}`);
  }
  assert.ok(TOP_BAR.includes("account.name"), "the live account line is gone — live mode must name the session's user");
  // "· owner" is the D120 `member.role` pin and is true only where a session
  // resolved it, so it may not ride on the mock branch's text.
  assert.ok(
    !/:\s*"[^"]*owner"/.test(TOP_BAR),
    "a fallback string claims the owner role — that claim belongs to a resolved session",
  );
});

test("no menu item in the shell is a door to nowhere", () => {
  assert.ok(!TOP_BAR.includes('href="#"'), "the account menu still has a dead link");
  assert.ok(!/href:\s*"#"/.test(TOP_BAR), "the account menu still has a dead link");
});

test("D228: the workspace line is a label, not a switcher that does not exist", () => {
  const start = SIDE_NAV.indexOf("data-workspace-id");
  assert.ok(start > 0, "SideNav no longer renders the workspace id");
  // The affordance: a chevroned button with no onClick promised a picker the
  // product has no requirement for and no menu behind.
  assert.ok(!SIDE_NAV.includes("ChevronsUpDown"), "the switcher chevron is back on the workspace line");
  const beforeId = SIDE_NAV.slice(0, start);
  assert.ok(
    !beforeId.slice(beforeId.lastIndexOf("<aside")).includes("<button"),
    "the workspace label is inside a button again — an affordance with nothing behind it",
  );
  // D115: the drive learns the tenant from this attribute and the text beside
  // it, so the label may lose its chrome but never this element.
  assert.ok(
    SIDE_NAV.includes("{workspaceId ?? \"loopwork-prod\"}"),
    "the workspace id text moved — the e2e drive reads it (D115)",
  );
});

test("the palette never offers the demo's traces to a live workspace", () => {
  // The three story ids exist in the mock corpus and nowhere else: in live mode
  // every one of them was a jump into a 404 (D60 as widened by D63).
  assert.ok(PALETTE.includes("live ? pages :"), "the palette builds one list for both modes again");
  const traceItemsUse = PALETTE.match(/traceItems/g) ?? [];
  assert.equal(traceItemsUse.length, 2, "traceItems is defined once and used on exactly the mock branch");
  // Unwired destinations still open — they just say what they render, one step
  // before the badge on the page says it.
  assert.ok(PALETTE.includes("isLiveWiredRoute"), "the palette stopped reading THE definition of a wired route (D21)");
  assert.ok(PALETTE.includes('"sample data"'), "unwired destinations lost their live-mode label");
});

test("D134/D228: the demo says it is a demo, from the shell, on every screen", () => {
  // D321: the footer moved out of the layout into its own client component so
  // it can read the ROUTE as well as the mode — the layout still owns the mode
  // gate below, and the file now owns "which routes". Same sentence, same
  // shell, one file further out.
  assert.ok(DEMO_FOOTER.includes("export function DemoFooter()"), "the app shell has no demo footer");
  assert.ok(LAYOUT.includes("{!live && <DemoFooter />}"), "the demo footer is not gated to the mock branch");
  // Live mode's marker is per-route and stays that way; the drive asserts the
  // absence of the badge string on wired routes, so the footer must not carry
  // it — and must not render there at all.
  assert.ok(!LAYOUT.includes("SAMPLE DATA"), "the footer borrowed the live badge's wording");
  assert.ok(!DEMO_FOOTER.includes("SAMPLE DATA"), "the footer borrowed the live badge's wording");
  // The sentence itself is the claim, so it is pinned character for character:
  // soften it and this goes red rather than the demo quietly getting vaguer
  // about being a demo.
  //
  // D326 — the middle of it is now `SAMPLE_COPY`, the ONE definition of the
  // words this product uses to say "none of this happened", shared with the
  // landing page's per-surface labels (`components/marketing/sample-copy.ts`).
  // The pin follows: the two halves are asserted in the file that renders them,
  // the middle in the module that defines it, and the reassembly is asserted to
  // be the same string this test has always demanded.
  const SAMPLE_COPY_MODULE = readFileSync(
    path.join(HERE, "../marketing/sample-copy.ts"),
    "utf8",
  );
  const middle = SAMPLE_COPY_MODULE.match(/export const SAMPLE_COPY = "([^"]+)";/)?.[1];
  assert.ok(middle, "the shared sample-data wording is no longer a single string literal");
  assert.ok(
    DEMO_FOOTER.includes("every screen here is {SAMPLE_COPY} — nothing is being ingested"),
    "the demo footer's sentence changed",
  );
  assert.equal(
    `every screen here is ${middle} — nothing is being ingested`,
    "every screen here is sample data from a fictional company — nothing is being ingested",
    "the demo footer's sentence changed",
  );
  assert.ok(DEMO_FOOTER.includes("DEMO WORKSPACE"), "the demo footer lost its label");
  assert.ok(LAYOUT.includes("<CommandPalette live={live} />"), "the palette lost the mode it needs to stay honest");
});

// D321 — the third route class. `/app/docs` renders the same MDX corpus the
// public `/docs` serves, out of the same build, in both images. Both of the
// shell's existing labels are therefore false about it in opposite directions:
// the live-mode badge would call a true self-hosting instruction sample data,
// and the mock-mode footer says "every screen here is sample data from a
// fictional company" UNDER it — on the demo host (D262), which is the one a
// stranger reads the docs on.
//
// Text, not render: both are `"use client"` components and the runner is
// pinned to `--conditions react-server` (D54(ii)), the same reason every
// assertion in this file reads source. What is asserted is the SHAPE that
// makes the claim mode-independent — the chrome check takes no mode, reads
// only the path, and comes before the class-specific check underneath it. The
// modes themselves are covered by the two gates in the layout: the badge only
// ever renders in live mode, the footer only in mock, and each returns null on
// chrome — so `/app/docs` carries neither, in either image.
test("D321: neither the badge nor the demo footer speaks over product chrome", () => {
  // The BODY, not the docblock: the prose above each component explains the
  // mode gate it does not itself apply, so the assertions below read from the
  // exported function onward.
  const bodyOf = (source: string) => source.slice(source.indexOf("export function"));
  for (const [name, source] of [["SampleDataBadge.tsx", BADGE], ["DemoFooter.tsx", DEMO_FOOTER]] as const) {
    const body = bodyOf(source);
    assert.ok(
      body.includes("isProductChromeRoute"),
      `${name} does not read THE definition of product chrome (D321)`,
    );
    assert.match(
      body,
      /if \(isProductChromeRoute\(pathname\)\) return null;/,
      `${name} does not render nothing on a chrome route`,
    );
    // The check may not be conditioned on the mode — a docs page is chrome in
    // the live image and in the mock image alike, and a mode-gated version of
    // this rule would silence one lie and leave the other standing.
    assert.equal(
      /\blive\b/.test(body),
      false,
      `${name} decides chrome by mode rather than by route`,
    );
  }
  // Ordering inside the badge: chrome is NOT in the live-wired set (registering
  // it there would claim it reads the facade), so a badge that asked "is this
  // wired?" first would fall straight through to rendering.
  const badgeBody = bodyOf(BADGE);
  assert.ok(
    badgeBody.indexOf("isProductChromeRoute(pathname)") < badgeBody.indexOf("isLiveWiredRoute(pathname)"),
    "the badge asks whether the route is wired before it asks whether it is chrome",
  );
  // The palette is the third consumer — the one the plan's own survey missed.
  // Its hint for a chrome destination says what the destination is, and it
  // answers before the mode branch, so the label is the same in both images.
  const hintFor = PALETTE.slice(PALETTE.indexOf("function hintFor("));
  assert.match(
    hintFor.slice(0, hintFor.indexOf("\n}")),
    /if \(isProductChromeRoute\(path\)\) return "docs";/,
    "the palette's chrome hint changed",
  );
  assert.ok(
    hintFor.indexOf("isProductChromeRoute(path)") < hintFor.indexOf("if (!live)"),
    "the palette answers by mode before it answers by class — chrome is labelled in both modes",
  );
});

test("the tour promises nothing the repo does not have", () => {
  // Each of these was a capability claim with no code behind it, or a
  // competitive claim nobody can check.
  const fictions: [string, string][] = [
    ["Generate root-cause analysis", "no such control exists on any surface"],
    ["No other tool", "an unverifiable competitive claim"],
    ["Every call is audit-logged", "there is no MCP server to log a call"],
    ["CloudWatch and plain OTLP work today", "Vercel and CloudWatch are coming-soon cards (D208)"],
  ];
  for (const [needle, why] of fictions) {
    assert.ok(!TOUR.includes(needle), `the tour claims "${needle}" — ${why}`);
  }
  // D442: the watches step no longer makes a storage-location claim — D425
  // split the two modes' mechanisms (mock: `WatchWidgets`'s own localStorage;
  // live: a dashboard widget's `pinned` flag in Postgres), so no ONE sentence
  // about where the layout lives can be true in both. The guard is now two
  // separate claims: the mock component still saves what it always did
  // (unchanged, D438), and the tour step names no storage location and no
  // fixture-only widget type at all — only what stays true in every mode.
  const watchWidgets = readFileSync(path.join(HERE, "../dash/WatchWidgets.tsx"), "utf8");
  assert.ok(
    watchWidgets.includes("localStorage.setItem"),
    "the mock watch board stopped being saved in the browser",
  );
  const watchStep = TOUR.slice(TOUR.indexOf('target: "watches"'));
  const watchStepBody = watchStep.slice(0, watchStep.indexOf("},"));
  for (const claim of ["this browser", "your account", "saved", "synced", "pod", "queue", "pipeline"]) {
    assert.ok(
      !watchStepBody.includes(claim),
      "the watches step claims a storage location or a fixture-only widget type; it must be true in both modes (D404/D442)",
    );
  }
  assert.ok(watchStepBody.includes("overview"), "the watches step stopped saying where pinned widgets show up");
  // The Explain step stopped being an invitation to a mock control and became a
  // claim about a shipped run (D232/D245): metered against the plan, evidence
  // pointing into the trace it explains, refusals stated. Each half is coupled
  // to the code that makes it true, so removing the behaviour turns this red
  // rather than leaving the copy quietly back in fiction.
  const explainRoute = readFileSync(path.join(HERE, "../../app/app/traces/[id]/explain/route.ts"), "utf8");
  assert.ok(
    explainRoute.includes('type: "refusal"'),
    "the Explain route stopped refusing in-band — the tour says the panel says so instead of guessing",
  );
  const explainPanel = readFileSync(path.join(HERE, "../trace/ExplainPanel.tsx"), "utf8");
  assert.ok(
    explainPanel.includes("Explain runs used this month"),
    "the panel's per-plan counter line moved — the tour says a run counts against the plan's month",
  );
  const traceStep = TOUR.slice(TOUR.indexOf('target: "trace-waterfall"'));
  const traceBody = traceStep.slice(0, traceStep.indexOf("},"));
  assert.ok(
    traceBody.includes("counts against your plan"),
    "the trace step dropped the quota half of the Explain claim — a metered run may not be offered as a free one",
  );
  // The other direction: the step may not go back to promising a control that
  // only the demo's prepared explanation puts on screen.
  assert.ok(!traceBody.includes("Try “Explain"), "the Explain step is an invitation again, not a description of the run");

  // The connectors the tour DOES name as working are the ones the single
  // connector definition marks available (D204) — read from that definition so
  // a status change here goes red rather than silently un-truing the copy.
  const connectors = readFileSync(path.join(HERE, "../connections/connectors.ts"), "utf8");
  const available = [...connectors.matchAll(/slug:\s*"([^"]+)"[\s\S]{0,200}?status:\s*"available"/g)].map((m) => m[1]);
  assert.deepEqual(available.sort(), ["docker", "kubernetes", "otlp"], "the available connector set changed");
  const step = TOUR.slice(TOUR.indexOf('path: "/app/connections"'));
  const body = step.slice(0, step.indexOf("},"));
  for (const name of ["OTLP", "Kubernetes", "Docker"]) {
    assert.ok(body.includes(name), `the connections step stopped naming ${name}, which connects today`);
  }
});
