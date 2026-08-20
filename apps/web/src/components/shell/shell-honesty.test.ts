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
const LAYOUT = readFileSync(path.join(HERE, "../../app/app/layout.tsx"), "utf8");

test("TopBar makes no claim about the running system", () => {
  // A throughput reading and a deployment region in the status strip: mock-mode
  // fabrications about the product itself, not demo telemetry. obstack has no
  // regions and the demo ingests nothing.
  for (const claim of ["9.4k", "events/min", "EU-CENTRAL", "ingesting"]) {
    assert.ok(!TOP_BAR.includes(claim), `TopBar claims "${claim}" — the bar carries no system status`);
  }
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
  assert.ok(LAYOUT.includes("function DemoFooter()"), "the app shell has no demo footer");
  assert.ok(LAYOUT.includes("{!live && <DemoFooter />}"), "the demo footer is not gated to the mock branch");
  // Live mode's marker is per-route and stays that way; the drive asserts the
  // absence of the badge string on wired routes, so the footer must not carry
  // it — and must not render there at all.
  assert.ok(!LAYOUT.includes("SAMPLE DATA"), "the footer borrowed the live badge's wording");
  assert.ok(LAYOUT.includes("<CommandPalette live={live} />"), "the palette lost the mode it needs to stay honest");
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
  // The watches step makes a persistence claim in either direction, so it is
  // coupled to where the widget list actually goes: localStorage, this browser,
  // never the server. Saying it resets on navigation would be as false as
  // promising a synced layout.
  const watchWidgets = readFileSync(path.join(HERE, "../dash/WatchWidgets.tsx"), "utf8");
  assert.ok(
    watchWidgets.includes("localStorage.setItem"),
    "the watch layout stopped being saved in the browser — the tour's sentence follows it",
  );
  const watchStep = TOUR.slice(TOUR.indexOf('target: "watches"'));
  assert.ok(
    watchStep.slice(0, watchStep.indexOf("},")).includes("kept in this browser"),
    "the watches step no longer says where the layout is kept",
  );
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
