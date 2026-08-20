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
    return { __esModule: true, X: () => null, Copy: () => null, Check: () => null, Bell: () => null };
  return origLoad.call(this, request, ...rest);
};

const { needsApiKey } = createRequire(fileURLToPath(import.meta.url))(
  "./ConnectModal.tsx",
) as typeof import("./ConnectModal");

const modalSource = readFileSync(path.join(import.meta.dirname, "ConnectModal.tsx"), "utf8");
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
  // Comments are stripped first — the deletion is recorded in one beside the
  // spot the row used to occupy, and that note must not read as the row.
  const code = modalSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  for (const fiction of ["waiting for first event", "pulse-dot"]) {
    assert.equal(code.includes(fiction), false, `${fiction} is back in the modal`);
  }
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
