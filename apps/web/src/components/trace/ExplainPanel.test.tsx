import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { oomTrace, rateTrace, slowTrace } from "@/mock/stories";
import type { Trace } from "@/lib/types";

// run with: npm test --workspace apps/web
//
// The Explain surface's provable half: the frame folded into what the panel
// shows, the counter line's numbers, and the two data facts the renderer stands
// on — every prepared citation resolves, and nothing fakes a stream any more.
// Same `require`-seam stubbing as `ConnectModal.test.tsx`: the panel is
// `"use client"` and imports `lucide-react` at module scope, which does not load
// under `--conditions react-server` (D54(ii)).
const origLoad = (Module as unknown as { _load: (r: string, ...a: unknown[]) => unknown })._load;
(Module as unknown as { _load: (r: string, ...a: unknown[]) => unknown })._load = function (
  request: string,
  ...rest: unknown[]
) {
  if (request === "lucide-react")
    return { __esModule: true, Sparkles: () => null, X: () => null };
  return origLoad.call(this, request, ...rest);
};

const {
  RUN_START,
  TRUNCATED_DETAIL,
  UNREACHABLE_DETAIL,
  applyExplainEvent,
  costsARun,
  endOfStream,
  explainCounterLine,
  runExplain,
} = createRequire(fileURLToPath(import.meta.url))(
  "./ExplainPanel.tsx",
) as typeof import("./ExplainPanel");

const source = (file: string) => readFileSync(path.join(import.meta.dirname, file), "utf8");
const panelSource = source("ExplainPanel.tsx");
const explorerSource = source("TraceExplorer.tsx");
// Comments state what was removed and why, so a scan for the removed thing has
// to read the code without them (the `ConnectModal.test.tsx` treatment).
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
const panelCode = strip(panelSource);
const explorerCode = strip(explorerSource);

const explanation = {
  headline: "h",
  failedWhere: "w",
  rootCause: "c",
  evidence: [{ label: "l", detail: "d" }],
  suggestion: "s",
};

test("deltas accumulate and a terminal event ends the run (D227 frame)", () => {
  const streamed = [
    { type: "delta" as const, text: "HEADLINE: pod " },
    { type: "delta" as const, text: "OOM-killed" },
  ].reduce(applyExplainEvent, RUN_START);
  assert.deepEqual(streamed, { phase: "streaming", text: "HEADLINE: pod OOM-killed" });

  const answered = applyExplainEvent(streamed, { type: "result", explanation });
  assert.deepEqual(answered, { phase: "answered", explanation });
  // A malformed frame that keeps writing after its terminal event does not get
  // to turn an answer back into a half-written document.
  assert.deepEqual(applyExplainEvent(answered, { type: "delta", text: "more" }), answered);
});

test("a refusal is an outcome the panel states, not an error it hides", () => {
  const detail = "No model is configured for this deployment, so no run was made.";
  const refused = applyExplainEvent(RUN_START, {
    type: "refusal",
    reason: "not-configured",
    detail,
  });
  assert.deepEqual(refused, { phase: "refused", detail });
  // The refusal's own words reach the screen — the panel has no copy of its own
  // to substitute, which is what keeps "not configured" from becoming a guess.
  assert.match(panelCode, /run\.phase === "refused"\s*\?\s*run\.detail/);
});

test("a stream with no terminal event is truncated, never a partial answer", () => {
  const half = applyExplainEvent(RUN_START, { type: "delta", text: "HEADLINE: half a" });
  assert.deepEqual(endOfStream(half), { phase: "truncated" });
  const answered = applyExplainEvent(RUN_START, { type: "result", explanation });
  assert.deepEqual(endOfStream(answered), answered);
});

test("what costs a run is what got past the increment (D225/D240 order)", () => {
  assert.equal(costsARun({ phase: "answered", explanation }), true);
  assert.equal(costsARun({ phase: "truncated" }), true, "a provider that died mid-run is counted");
  assert.equal(costsARun({ phase: "refused", detail: "x" }), false, "a refusal is decided before the spend");
  assert.equal(costsARun({ phase: "unreachable" }), false, "no stream came back — nothing was spent");
  assert.equal(costsARun(RUN_START), false);
});

test("the counter line is the plan's numbers, and no number lives in this file", () => {
  assert.equal(explainCounterLine(4, 20), "4 of 20 Explain runs used this month");
  assert.equal(explainCounterLine(200, 200), "200 of 200 Explain runs used this month");
  // The fiction of record at `ExplainPanel.tsx:111` before this pass.
  assert.equal(panelCode.includes("4 of 20"), false);
  assert.equal(/\b(20|200)\b/.test(panelCode), false, "an Explain quota is spelled in TypeScript again");
});

test("the RAF fake stream is gone, and no motion fork replaced it (D230)", () => {
  for (const fiction of ["requestAnimationFrame", "cancelAnimationFrame", "prefers-reduced-motion", "performance.now"]) {
    assert.equal(panelCode.includes(fiction), false, `${fiction} is back in the panel`);
  }
  // The one sentence D230 asks the panel to carry, in the comments the scan strips.
  assert.match(panelSource, /prefers-reduced-motion/);
});

test("the fabricated share URL is gone from the trace view (D231.4)", () => {
  for (const fiction of ["obstack.dev/share", "shareUrl", "Public link"]) {
    assert.equal(explorerCode.includes(fiction), false, `${fiction} is back in TraceExplorer`);
  }
  // What replaced it is nothing: copy-link copies the page's own URL.
  assert.match(explorerCode, /navigator\.clipboard\.writeText\(window\.location\.href\)/);
});

test("live mode gates Explain on the failure alone (D224)", () => {
  assert.match(explorerCode, /hasFailure && \(explain\.live \|\| trace\.explanation\)/);
  // The panel is opened without one too: live has no `trace.explanation` to
  // render and fetches the run instead.
  assert.match(explorerCode, /\{explainOpen && \(/);
});

test("an answer survives closing the panel, so reopening spends nothing (D189/D225)", () => {
  // The panel unmounts on close; the page keeps what the run produced and hands
  // it back as an explanation already in hand, which is the branch that does not
  // fetch. Without this, closing and reopening is a second metered run the
  // reader never asked for.
  assert.match(explorerCode, /prepared=\{trace\.explanation \?\? answered \?\? undefined\}/);
  assert.match(explorerCode, /run\.phase === "answered"\) setAnswered\(run\.explanation\)/);
  assert.match(panelCode, /if \(prepared\) return;/);
});

test("every prepared citation resolves inside its own trace (D223)", () => {
  for (const trace of [oomTrace, slowTrace, rateTrace] as Trace[]) {
    const spanIds = new Set(trace.spans.map((s) => s.id));
    const logIds = new Set(trace.logs.map((l) => l.id));
    const evidence = trace.explanation?.evidence ?? [];
    assert.ok(evidence.length > 0, `${trace.id} has no prepared evidence`);
    let linked = 0;
    for (const item of evidence) {
      if (item.spanId) {
        assert.ok(spanIds.has(item.spanId), `${item.spanId} is not a span of ${trace.id}`);
        linked++;
      }
      if (item.logRef) {
        assert.ok(logIds.has(item.logRef), `${item.logRef} is not a log of ${trace.id}`);
        linked++;
      }
      // Exactly ONE of the four reference keys (D553 widened two to four): a
      // prepared trace citation is a span or a log, never both, and never an
      // incident's `eventRef`/`traceRef` — those are the other subject's.
      const keys = (["spanId", "logRef", "eventRef", "traceRef"] as const).filter((key) => item[key]);
      assert.deepEqual(
        keys.length,
        1,
        `an evidence item cites exactly one thing, not ${keys.length} (${keys.join(", ")})`,
      );
    }
    // The backfill is the point: a demo whose citations were prose would still
    // render through this renderer, and show none of the links live mode has.
    assert.equal(linked, evidence.length, `${trace.id} has an unlinked prepared citation`);
  }
});

/**
 * The wire, driven from the reader's end (D233.3): the route's own frame writer
 * is `encodeExplainEvent`, so a run is served here exactly as the route serves
 * it — split across chunk boundaries that fall nowhere near a newline, which is
 * the case a reader gets wrong.
 */
function serve(
  frame: string,
  init: { status?: number } = {},
): { calls: { url: string; method?: string }[]; fetch: typeof fetch } {
  const calls: { url: string; method?: string }[] = [];
  const bytes = new TextEncoder().encode(frame);
  const fake = async (url: string | URL | Request, options?: RequestInit) => {
    calls.push({ url: String(url), method: options?.method });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let at = 0; at < bytes.length; at += 7) controller.enqueue(bytes.slice(at, at + 7));
        controller.close();
      },
    });
    return new Response(init.status && init.status !== 200 ? null : body, {
      status: init.status ?? 200,
    });
  };
  return { calls, fetch: fake as unknown as typeof fetch };
}

async function drive(frame: string, init?: { status?: number }) {
  const served = serve(frame, init);
  const original = globalThis.fetch;
  globalThis.fetch = served.fetch;
  const seen: unknown[] = [];
  try {
    // The url is the caller's since S7.4 (D552): this is the one the panel
    // builds for a trace, asserted below against what was actually fetched.
    const final = await runExplain("/app/traces/a3f8c1d92b6e407f/explain", new AbortController().signal, (run) =>
      seen.push(run),
    );
    return { final, seen, calls: served.calls };
  } finally {
    globalThis.fetch = original;
  }
}

test("a served run POSTs the trace's own route and ends in the summary (D227)", async () => {
  const encode = (e: unknown) => `${JSON.stringify(e)}\n`;
  const { final, seen, calls } = await drive(
    encode({ type: "delta", text: "HEADLINE: pod OOM-killed\n" }) +
      encode({ type: "delta", text: "EVIDENCE: s-oom-draft | span | truncated\n" }) +
      encode({ type: "result", explanation }),
  );
  assert.deepEqual(calls, [
    { url: "/app/traces/a3f8c1d92b6e407f/explain", method: "POST" },
  ]);
  // ⟨S7.4 T5 review, D579⟩ Since `runExplain` takes a url (D552), the line
  // above pins only that the url handed in is the url fetched, with POST. The
  // trace's path is now built at the component's call site, so that site is
  // pinned here too — otherwise the encoded id and the exact `/explain` path
  // are asserted nowhere but the e2e drive, while the incident panel pins its
  // `rcaUrl` in its own unit test.
  assert.match(
    panelCode,
    /runExplain\(`\/app\/traces\/\$\{encodeURIComponent\(traceId\)\}\/explain`, abort\.signal, setRun\)/,
    "the trace panel no longer posts to /app/traces/<id>/explain with the id encoded",
  );
  // Call sites only — the declaration `function runExplain(` is not one.
  assert.equal((panelCode.match(/(?<!function )runExplain\(/g) ?? []).length, 1, "a second call site started a run");
  assert.deepEqual(final, { phase: "answered", explanation });
  // The deltas were shown as they arrived — that is the whole of D230's "real
  // chunks": three states, not one jump from empty to answered.
  assert.equal(seen.length, 3);
  assert.deepEqual(seen[0], { phase: "streaming", text: "HEADLINE: pod OOM-killed\n" });
});

test("a refusal arrives over 200 and is the run's outcome (D241)", async () => {
  const detail = "This workspace has used all 20 Explain runs its plan includes this month.";
  const { final } = await drive(
    `${JSON.stringify({ type: "refusal", reason: "over-quota", detail })}\n`,
  );
  assert.deepEqual(final, { phase: "refused", detail });
  assert.equal(costsARun(final), false);
});

test("a stream that stops mid-answer is truncated, and a 401/404 never ran", async () => {
  const { final } = await drive(`${JSON.stringify({ type: "delta", text: "HEADLINE: half" })}\n`);
  assert.deepEqual(final, { phase: "truncated" });
  for (const status of [401, 404]) {
    assert.deepEqual((await drive("", { status })).final, { phase: "unreachable" }, `${status}`);
  }
});

test("the panel's own endings read as outcomes, not as error lines (D206)", () => {
  for (const detail of [TRUNCATED_DETAIL, UNREACHABLE_DETAIL]) {
    assert.equal(/Error\b|⨯|unhandledRejection/.test(detail), false, detail);
    assert.ok(detail.length > 40, "an ending states what happened");
  }
});
