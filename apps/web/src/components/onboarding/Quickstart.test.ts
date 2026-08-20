import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { API_KEY_PLACEHOLDER } from "@/components/connections/connectors";
import { OTLP_GRPC_ENDPOINT, OTLP_HTTP_ENDPOINT } from "@/lib/ingest-endpoint";

// run with: npm test --workspace apps/web
//
// The quickstart's snippets are a claim about an API that is FROZEN (D78) and
// about packages that exist (D79), and D101 recorded four ways the old ones lied.
// This file is that byte-level review turned into assertions, checked against the
// two SDK READMEs and `packages/obstack-js/package.json` themselves — so the
// snippets go stale with the SDKs rather than after them.
//
// Text, not import: `Quickstart.tsx` is a `"use client"` component and the runner
// is pinned to `--conditions react-server`, which cannot load one (D54(ii)). The
// two values the snippets interpolate ARE imported, from the plain modules that
// own them, so the assertions below are about the same strings the render uses.

const HERE = import.meta.dirname;
const REPO_ROOT = path.resolve(HERE, "../../../../..");

const source = readFileSync(path.join(HERE, "Quickstart.tsx"), "utf8");
const pyReadme = readFileSync(path.join(REPO_ROOT, "packages/obstack-py/README.md"), "utf8");
const jsReadme = readFileSync(path.join(REPO_ROOT, "packages/obstack-js/README.md"), "utf8");
const jsPackage = JSON.parse(
  readFileSync(path.join(REPO_ROOT, "packages/obstack-js/package.json"), "utf8"),
) as { version: string; peerDependencies: Record<string, string> };

/**
 * What one tab actually shows: the file's template literal with its three
 * interpolations resolved the way the component resolves them — the two endpoint
 * constants, the packed version, and the token slot before a key is issued. So
 * the assertions below compare rendered text against the READMEs' text, while
 * the "nothing is hardcoded" test reads `source` and sees the interpolations.
 */
const INTERPOLATIONS: Record<string, string> = {
  "${OTLP_HTTP_ENDPOINT}": OTLP_HTTP_ENDPOINT,
  "${OTLP_GRPC_ENDPOINT}": OTLP_GRPC_ENDPOINT,
  "${OBSTACK_JS_VERSION}": jsPackage.version,
  "${key}": API_KEY_PLACEHOLDER,
};

function tabCode(id: string): string {
  const start = source.indexOf(`id: "${id}"`);
  assert.ok(start > 0, `no ${id} tab in the file`);
  const open = source.indexOf("code: `", start);
  const close = source.indexOf("`,", open + 7);
  assert.ok(open > 0 && close > open, `no code block on the ${id} tab`);
  let code = source.slice(open + 7, close);
  for (const [slot, value] of Object.entries(INTERPOLATIONS)) code = code.split(slot).join(value);
  assert.equal(/\$\{/.test(code), false, `an unresolved interpolation on the ${id} tab: ${code}`);
  return code;
}

const python = tabCode("python");
const typescript = tabCode("typescript");
const otel = tabCode("otel");
const allCode = [python, typescript, otel].join("\n");

// D101 defect 1: the packages are `obstack-py` / `obstack-js`, and the install
// lines are the READMEs' own — the in-repo install that works today (D202).
test("install lines are the READMEs' verbatim, naming the held package names", () => {
  const pipLine = "pip install './packages/obstack-py[fastapi]'";
  assert.ok(pyReadme.includes(pipLine), "the Python README no longer documents that install");
  assert.ok(python.includes(pipLine), "the Python tab must render the README's install line");

  const pack = `npm pack ./packages/obstack-js        # -> obstack-js-${jsPackage.version}.tgz`;
  const install = `npm install ./obstack-js-${jsPackage.version}.tgz`;
  assert.ok(jsReadme.includes(pack) && jsReadme.includes(install), "the JS README's install moved");
  assert.ok(typescript.includes(pack), "the TypeScript tab must render the README's pack line");
  assert.ok(typescript.includes(install), "the tgz literal must match package.json's version");
  assert.ok(
    source.includes(`OBSTACK_JS_VERSION = "${jsPackage.version}"`),
    "the mirrored pack version drifted from packages/obstack-js/package.json",
  );
});

// D202: one caveat line, and exactly one — the registry names are held (U5), the
// real releases publish at launch.
test("the pre-release caveat is stated once", () => {
  const hits = source.match(/pre-release:/g) ?? [];
  assert.equal(hits.length, 1, "exactly one caveat line (D202: not both install forms, no dual copy)");
  assert.match(source, /registry names are\s*\n?\s*reserved/);
});

// D101 defect 2: the frozen D78 API takes NO arguments in either language.
test("init() is zero-arg in both languages", () => {
  assert.ok(python.includes("import obstack"));
  assert.ok(python.includes("obstack.init()"));
  assert.ok(typescript.includes('import { init } from "obstack-js";'));
  assert.ok(typescript.includes("init();"));
  for (const lie of ["api_key=", "apiKey:", "obstack.init(api_key", "init({"]) {
    assert.equal(allCode.includes(lie), false, `the snippets pass ${lie} to an API that takes nothing`);
  }
});

// The env blocks are the READMEs' — including the URL-encoding, which is not
// decoration: an OTel SDK drops a header value with a raw space.
test("each env line is a line the SDK's own README documents", () => {
  const bearer = "OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer%20";
  for (const [code, readme, name] of [
    [python, pyReadme, "python"],
    [typescript, jsReadme, "typescript"],
  ] as const) {
    assert.ok(readme.includes("export OTEL_SERVICE_NAME=my-agent"), `${name} README env block moved`);
    assert.ok(code.includes("export OTEL_SERVICE_NAME=my-agent"), `${name} tab: service name`);
    assert.ok(readme.includes(`export ${bearer}`), `${name} README no longer URL-encodes the header`);
    assert.ok(code.includes(`export ${bearer}`), `${name} tab: URL-encoded Bearer header`);
    assert.ok(
      readme.includes(`export OTEL_EXPORTER_OTLP_ENDPOINT=${OTLP_HTTP_ENDPOINT}`),
      `${name} README's endpoint is no longer this environment's`,
    );
  }
  assert.ok(otel.includes(`export ${bearer}`), "the OTel tab: URL-encoded Bearer header");
});

// The asymmetry is a measured fact of the two SDKs, not an oversight: Python's
// init() defaults the semconv variable, obstack-js never reads it and its README
// warns against copying the line across.
test("the SEMCONV note is Python's only, and PROTOCOL follows the same rule", () => {
  assert.ok(python.includes("OTEL_SEMCONV_STABILITY_OPT_IN=http"));
  assert.ok(python.includes("OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf"));
  assert.equal(
    typescript.includes("export OTEL_SEMCONV_STABILITY_OPT_IN"),
    false,
    "the JS tab must not set a variable obstack-js does not read",
  );
  assert.equal(
    typescript.includes("export OTEL_EXPORTER_OTLP_PROTOCOL"),
    false,
    "obstack-js builds its own exporters; the protocol variable is not read",
  );
  assert.ok(jsReadme.includes("do not copy its setup across"), "the JS README's warning moved");
});

// D101 defect 4: the wire contract is `Authorization: Bearer` (D4/D6), and
// D101 defect 3 + U1: the endpoint is this environment's, from the one constant.
test("no forbidden literal survives anywhere in the file", () => {
  for (const lie of ["x-obstack-key", "ingest.obstack.dev", "obstack.dev", "ok_live_9f2e"]) {
    assert.equal(source.includes(lie), false, `${lie} is back in the quickstart`);
  }
  // The endpoints are interpolated, never spelled: one definition (D215).
  assert.ok(source.includes("OTLP_HTTP_ENDPOINT") && source.includes("OTLP_GRPC_ENDPOINT"));
  assert.equal(source.includes(OTLP_HTTP_ENDPOINT), false, "the endpoint is hardcoded again");
  assert.equal(source.includes(OTLP_GRPC_ENDPOINT), false, "the gRPC endpoint is hardcoded again");
  assert.equal(source.includes("endpoint:"), false, "the D209 endpoint prop is gone (D215)");
});

// D101 defect 3: the demo's 5-second flip is the DEMO's. Live mode polls the
// real status route and stops on arrival or on any non-200 (D203/D216).
test("live arrival is polled, never timed", () => {
  assert.ok(source.includes('"/app/onboarding/status"'), "the poll target is the D203 GET route");
  assert.ok(source.includes("POLL_MS = 5_000"), "the poll matches the counters' flush cadence");
  assert.match(source, /if \(!response\.ok\) \{\s*\n\s*stopped = true;/, "a non-200 must stop the poll");
  assert.match(source, /if \(!isLive \|\| linked\) return;/, "arrival stops the poll");
  // The timer that exists is inside the mock branch, and the mock rows are only
  // reachable from the component live mode never renders.
  assert.match(source, /if \(isLive\) return;\s*\n\s*const reduced/);
  const demo = source.slice(source.indexOf("function DemoArrival"));
  assert.ok(demo.includes("allTraces.find"), "the mock trace link belongs to the demo panel");
  assert.equal(
    source.slice(0, source.indexOf("function DemoArrival")).includes("allTraces."),
    false,
    "the mock rows must be unreachable outside the demo panel",
  );
});

// D201: the token is client state and nothing else — a shown-once key (D98) has
// no other honest lifetime, and a token in a URL is a token in every access log.
test("the issued token never leaves client state", () => {
  assert.ok(source.includes("useState<string | null>(null)"), "the token lives in state");
  for (const leak of ["localStorage", "sessionStorage", "document.cookie", "searchParams", "?token"]) {
    assert.equal(source.includes(leak), false, `the token reaches ${leak}`);
  }
  // Before issuance every snippet carries the shared placeholder — the same
  // string the connector steps interpolate against (D204/D210).
  assert.equal(API_KEY_PLACEHOLDER, "<OBSTACK_API_KEY>");
  assert.ok(source.includes("token ?? API_KEY_PLACEHOLDER"));
  assert.ok(source.includes("Bearer%20${key}"), "one token slot, filled in one place");
  assert.equal(
    allCode.split(API_KEY_PLACEHOLDER).length - 1,
    3,
    "every tab's header carries the slot before a key is issued",
  );
});

// D88/D101: the ranges the auto-instrumentation is measured against, and the
// absence stated rather than left to be discovered.
test("the version fences match package.json and ai@7 is named absent", () => {
  assert.equal(jsPackage.peerDependencies.ai, ">=5 <7");
  const fences = source.replace(/&gt;/g, ">").replace(/&lt;/g, "<");
  for (const [name, range] of Object.entries(jsPackage.peerDependencies)) {
    assert.ok(fences.includes(`${name} ${range}`), `the fence for ${name} is not ${range}`);
  }
  assert.ok(fences.includes("ai@7 is not yet supported"));
});
