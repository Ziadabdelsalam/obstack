import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { API_KEY_PLACEHOLDER, connectors } from "./connectors";

// run with: npm test --workspace apps/web
//
// The connect modal's one decision — does this card's flow need a key of ours —
// plus the two facts D210 states about the modal that have no function to ask.
// Same `require`-seam stubbing as `ConnectionsHub.test.tsx`: the module is
// `"use client"` and imports `next/link` and `lucide-react` at the top level,
// neither of which loads under `--conditions react-server` (D54(ii)).
const origLoad = (Module as unknown as { _load: (r: string, ...a: unknown[]) => unknown })._load;
(Module as unknown as { _load: (r: string, ...a: unknown[]) => unknown })._load = function (
  request: string,
  ...rest: unknown[]
) {
  if (request === "next/link") return { __esModule: true, default: () => null };
  if (request === "lucide-react")
    return { __esModule: true, X: () => null, Copy: () => null, Check: () => null, Plus: () => null };
  return origLoad.call(this, request, ...rest);
};

const { needsApiKey } = createRequire(fileURLToPath(import.meta.url))(
  "./ConnectModal.tsx",
) as typeof import("./ConnectModal");

const modalSource = readFileSync(path.join(import.meta.dirname, "ConnectModal.tsx"), "utf8");
// Rendered copy only: each deletion of record is noted in a comment beside the
// spot it used to occupy, and a note must never read as the claim it removed.
const modalCode = modalSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
const card = (slug: string) => {
  const found = connectors.find((c) => c.slug === slug);
  assert.ok(found, `${slug} card missing`);
  return found;
};

// D210: the issue-a-key line appears exactly where a snippet has a slot to
// fill. D214 is the case that makes this a function rather than a flag on the
// card: Kubernetes is `available`, has real steps, and needs no key of ours —
// the chart authenticates against its own Postgres.
test("the key line follows the placeholder, so the K8s card gets none", () => {
  assert.equal(needsApiKey(card("otlp")), true);
  assert.equal(needsApiKey(card("docker")), true);
  assert.equal(needsApiKey(card("kubernetes")), false);
  // A coming-soon card has no steps at all.
  assert.equal(needsApiKey(card("vercel")), false);
});

// The fiction that is gone (D210): a hardcoded row that said "waiting for first
// event…" on every open, forever, including in a workspace already receiving
// data. Arrival lives on the hub's connected panel, off the D100 counters.
test("no waiting row and no pretend arrival state", () => {
  for (const fiction of ["waiting for first event", "pulse-dot"]) {
    assert.equal(modalCode.includes(fiction), false, `${fiction} is back in the modal`);
  }
});

// D220: the request button sets a `useState` flag and reaches nothing else — no
// action, no fetch, nothing written anywhere. So the acknowledgment promises no
// delivery and names no channel; U4 puts email furthest out of reach of all.
test("the request acknowledgment promises no delivery on any channel", () => {
  for (const promise of [
    /email/i,
    /notif/i,
    /\bwe(&apos;|')?ll\b/i,
    /get back to you/i,
    /\bin touch\b/i,
    /let you know/i,
    /\bsubscrib/i,
  ]) {
    assert.equal(promise.test(modalCode), false, `${promise} is a promise the modal cannot keep`);
  }
  // The affordance itself stays — a local acknowledgment, scoped out loud.
  assert.match(modalCode, /Request this connector/);
  assert.match(modalCode, /Noted for this session/);
  // And nothing but local state sits behind the click.
  assert.match(modalCode, /onClick=\{\(\) => setRequested\(true\)\}/);
  assert.equal(/fetch\(|useActionState|action=/.test(modalCode), false);
  // D222: a bell is the notification promise in pictogram form — the icon may
  // not restate the claim D220 removed from the words. Plus carries "register
  // interest" and promises no follow-up channel.
  assert.equal(/\bBell\b/.test(modalSource), false, "Bell restates the notification promise (D222)");
});

// No real token enters this component (D210): it renders the slot literal and
// links to the surfaces that issue keys, and the clipboard copies the step's
// own code — the placeholder form, never an interpolated secret.
test("the modal holds no token: the slot literal, and links to issue one", () => {
  assert.ok(modalSource.includes("{API_KEY_PLACEHOLDER}"), "the slot literal must be rendered");
  assert.equal(API_KEY_PLACEHOLDER, "<OBSTACK_API_KEY>");
  assert.match(modalSource, /href="\/app\/onboarding"/);
  assert.match(modalSource, /Settings → API keys/);
  // The copy button copies the step's snippet as defined and nothing else.
  assert.match(modalSource, /navigator\.clipboard\.writeText\(code\)/);
  assert.equal(/token/i.test(modalSource.replace(/token slot|no token|a token/gi, "")), false);
});

// D281/D282 — the endpoint substitution, tested on the exported pure resolver
// (one definition; restating the rule here would be the drift D206 warns
// about). Three corners of the done-check plus the absence texts' remedy
// names.
test("endpoint placeholders: no override substitutes the loopback constants byte-identically", async () => {
  const { resolveStepSnippet } = await import("./ConnectModal");
  const { OTLP_HTTP_PLACEHOLDER, OTLP_GRPC_PLACEHOLDER } = await import("./connectors");
  const { OTLP_HTTP_ENDPOINT, OTLP_GRPC_ENDPOINT } = await import("@/lib/ingest-endpoint");
  const defaults = { http: OTLP_HTTP_ENDPOINT, grpc: OTLP_GRPC_ENDPOINT };
  const otlp = connectors.find((c) => c.slug === "otlp")!;
  for (const step of otlp.connectSteps ?? []) {
    if (!step.snippet) continue;
    const resolved = resolveStepSnippet(step.snippet, defaults);
    assert.ok("code" in resolved, "no step goes absent under the defaults");
    assert.equal(/<OBSTACK_OTLP_/.test(resolved.code), false, "an unsubstituted endpoint slot");
    if (step.snippet.includes(OTLP_HTTP_PLACEHOLDER))
      assert.ok(resolved.code.includes(OTLP_HTTP_ENDPOINT));
    if (step.snippet.includes(OTLP_GRPC_PLACEHOLDER))
      assert.ok(resolved.code.includes(OTLP_GRPC_ENDPOINT));
  }
});

test("endpoint placeholders: HTTP-only override — the gRPC step goes absent naming its remedy, no loopback anywhere", async () => {
  const { resolveStepSnippet } = await import("./ConnectModal");
  const { OTLP_GRPC_ENDPOINT } = await import("@/lib/ingest-endpoint");
  const httpOnly = { http: "https://ingest.example.com/v1", grpc: null };
  const otlp = connectors.find((c) => c.slug === "otlp")!;
  const results = (otlp.connectSteps ?? [])
    .filter((s) => s.snippet)
    .map((s) => resolveStepSnippet(s.snippet!, httpOnly));
  const codes = results.filter((r) => "code" in r) as Array<{ code: string }>;
  const absences = results.filter((r) => "absence" in r) as Array<{ absence: string }>;
  assert.equal(absences.length, 1, "exactly the gRPC step goes absent");
  assert.ok(absences[0].absence.includes("OBSTACK_PUBLIC_OTLP_GRPC_ENDPOINT"), "the absence names its remedy");
  for (const { code } of codes) {
    assert.equal(code.includes(OTLP_GRPC_ENDPOINT), false, "never a loopback beside a public endpoint");
    assert.ok(code.includes(httpOnly.http));
  }
});

test("endpoint placeholders: both overridden — both steps render the configured pair", async () => {
  const { resolveStepSnippet } = await import("./ConnectModal");
  const both = { http: "https://ingest.example.com/v1", grpc: "https://ingest.example.com:4317" };
  const otlp = connectors.find((c) => c.slug === "otlp")!;
  const codes = (otlp.connectSteps ?? [])
    .filter((s) => s.snippet)
    .map((s) => resolveStepSnippet(s.snippet!, both));
  assert.ok(codes.every((r) => "code" in r), "nothing goes absent with both configured");
  const joined = codes.map((r) => ("code" in r ? r.code : "")).join("\n");
  assert.ok(joined.includes(both.http) && joined.includes(both.grpc));
  assert.equal(/127\.0\.0\.1:(4317|4318)/.test(joined), false, "no loopback under a full override");
});
