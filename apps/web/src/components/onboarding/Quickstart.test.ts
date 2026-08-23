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
// no-override default values ARE imported, from the plain module that owns
// them; the display rule's overridden cases below are exercised against
// literal test values run through the same interpolation `tabCode` performs
// (D277 — the actual overrides are server-resolved and arrive as props, which
// this runner cannot exercise on a hook-using client component either way).

const HERE = import.meta.dirname;
const REPO_ROOT = path.resolve(HERE, "../../../../..");

const source = readFileSync(path.join(HERE, "Quickstart.tsx"), "utf8");
const pyReadme = readFileSync(path.join(REPO_ROOT, "packages/obstack-py/README.md"), "utf8");
const jsReadme = readFileSync(path.join(REPO_ROOT, "packages/obstack-js/README.md"), "utf8");
const jsPackage = JSON.parse(
  readFileSync(path.join(REPO_ROOT, "packages/obstack-js/package.json"), "utf8"),
) as { version: string; peerDependencies: Record<string, string> };

/**
 * The gRPC line is assembled OUTSIDE the `code:` block (`snippetsFor`'s
 * `grpcLine`), so the slice below cannot see it — its template is read out of
 * the source too, not restated here: a restatement the file is never compared
 * against is the comment D206 warns about, and it would let the default
 * render's wording drift while this suite stayed green.
 */
const GRPC_LINE_TEMPLATE = (() => {
  const open = source.indexOf("? `\\n\\n# gRPC instead:");
  assert.ok(open > 0, "no gRPC line template in snippetsFor");
  const start = open + "? `".length;
  return source.slice(start, source.indexOf("`", start)).replace(/\\n/g, "\n");
})();

/**
 * What one tab actually shows: the file's template literal with its
 * interpolations resolved the way the component resolves them. `http` and
 * `grpcLine` are the two the display rule (D277) varies per render — the rest
 * (the packed version, the token slot) never do. `grpcLine` is a whole extra
 * line, present only when an endpoint pair actually has a gRPC address to show.
 */
function tabCode(id: string, endpoints: { http: string | null; grpc: string | null }): string {
  // The SDK tabs are `sdkTab("<id>", "<Label>", `...`)` calls (D282's absence
  // refactor); the otel tab keeps its `id:` object shape but its `code:` is
  // now a conditional with TWO literals — http-branch first, gRPC-only branch
  // second. Backtick-scan from the id string; neither label nor literal
  // contains a backtick, so the nth backtick pair is the nth literal.
  const idIdx = source.indexOf(`"${id}"`);
  assert.ok(idIdx > 0, `no ${id} tab in the file`);
  const literalAt = (which: number): string => {
    let open = source.indexOf("`", idIdx);
    for (let i = 0; i < which; i++) open = source.indexOf("`", source.indexOf("`", open + 1) + 1);
    const close = source.indexOf("`", open + 1);
    assert.ok(open > idIdx && close > open, `no code literal ${which} on the ${id} tab`);
    return source.slice(open + 1, close);
  };
  let code = literalAt(id === "otel" && !endpoints.http ? 1 : 0);
  const grpcLine = endpoints.grpc
    ? GRPC_LINE_TEMPLATE.split("${grpc}").join(endpoints.grpc)
    : "";
  const interpolations: Record<string, string> = {
    "${http}": endpoints.http ?? "",
    "${grpc}": endpoints.grpc ?? "",
    "${grpcLine}": grpcLine,
    "${OBSTACK_JS_VERSION}": jsPackage.version,
    "${key}": API_KEY_PLACEHOLDER,
  };
  for (const [slot, value] of Object.entries(interpolations)) code = code.split(slot).join(value);
  assert.equal(/\$\{/.test(code), false, `an unresolved interpolation on the ${id} tab: ${code}`);
  return code;
}

/** No override (D266/D277): both loopback defaults, same as every checkout. */
const DEFAULT_ENDPOINTS = { http: OTLP_HTTP_ENDPOINT, grpc: OTLP_GRPC_ENDPOINT };

const python = tabCode("python", DEFAULT_ENDPOINTS);
const typescript = tabCode("typescript", DEFAULT_ENDPOINTS);
const otel = tabCode("otel", DEFAULT_ENDPOINTS);
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
  // The endpoints are interpolated, never spelled: one definition (D215), and
  // the identifiers below appear only as the demo/no-override FALLBACK
  // (D266/D277) — the snippets themselves interpolate `endpoints.http` /
  // `endpoints.grpc`, never the constants directly.
  assert.ok(source.includes("OTLP_HTTP_ENDPOINT") && source.includes("OTLP_GRPC_ENDPOINT"));
  assert.equal(source.includes(OTLP_HTTP_ENDPOINT), false, "the endpoint is hardcoded again");
  assert.equal(source.includes(OTLP_GRPC_ENDPOINT), false, "the gRPC endpoint is hardcoded again");
});

// D277: D215 deleted the `endpoint` prop when there was nothing to configure;
// M4 gives operators a real override, so the prop is back, server-resolved and
// plural — one endpoint pair, not one address (D266).
test("the endpoint prop is back, server-resolved (D209 as amended by D277)", () => {
  assert.ok(source.includes("endpoints: ResolvedEndpoints;"), "the live arm carries the resolved pair");
  assert.ok(
    source.includes('import { OTLP_GRPC_ENDPOINT, OTLP_HTTP_ENDPOINT } from "@/lib/ingest-endpoint";'),
    "only the client-safe constants are imported directly — the resolver lives server-side",
  );
  assert.equal(
    /from ["']@\/server\/ingest-endpoint["']/.test(source),
    false,
    "a \"use client\" file cannot import the server-only resolver — its result arrives as a prop",
  );
});

// D101 defect 3: the demo's 5-second flip is the DEMO's. Live mode polls the
// real status route and stops on arrival or on any non-200 (D203/D216).
test("live arrival is polled, never timed", () => {
  assert.ok(source.includes('"/app/onboarding/status"'), "the poll target is the D203 GET route");
  assert.ok(source.includes("POLL_MS = 5_000"), "the poll matches the counters' flush cadence");
  assert.match(source, /if \(!response\.ok\) \{\s*\n\s*stopped = true;/, "a non-200 must stop the poll");
  assert.match(source, /if \(!isLive \|\| linked\) return;/, "arrival stops the poll");
  // The demo's timer lives with the demo's panel now (D217) — this file has no
  // arrival timer at all, only the 1.5s "copied" reset on the clipboard button.
  assert.equal(source.includes("5000"), false, "the demo's 5-second flip is not this file's");
});

// D217: "live mode never renders it" was a claim about a render, not about the
// bundle — the mock import sat in the live surface's module graph waiting for a
// refactor to re-reach it (S1 L2 / D125/D158). The demo panel is a prop now, so
// this file must name no mock module in any form.
test("the live surface has no edge to @/mock/*", () => {
  assert.equal(/from "@\/mock\//.test(source), false, "Quickstart.tsx imports a mock module again");
  assert.equal(source.includes("@/mock/"), false, "no mock module is named in this file at all");
  assert.equal(source.includes("allTraces"), false, "the mock rows are reachable from the live file");
  assert.ok(source.includes("demoArrival"), "the demo panel arrives as a prop from the mock caller");
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

// D277's display rule, on the ONE tab that ever names gRPC. `tabCode` builds
// the "otel" tab's actual text for a given resolved pair — the same
// interpolation `snippetsFor` performs at render — so these three are the
// three cases the done-check names, each against the rendered string.
test("display rule — no override: both loopback defaults, byte-identical", () => {
  const rendered = tabCode("otel", DEFAULT_ENDPOINTS);
  assert.ok(rendered.includes(`OTEL_EXPORTER_OTLP_ENDPOINT=${OTLP_HTTP_ENDPOINT}`));
  assert.ok(
    rendered.includes(`# gRPC instead: ${OTLP_GRPC_ENDPOINT} with OTEL_EXPORTER_OTLP_PROTOCOL=grpc`),
  );
});

test("display rule — HTTP override alone: configured HTTP renders, no loopback gRPC anywhere", () => {
  const configuredHttp = "https://ingest.example.com:4318";
  const rendered = tabCode("otel", { http: configuredHttp, grpc: null });
  assert.ok(rendered.includes(`OTEL_EXPORTER_OTLP_ENDPOINT=${configuredHttp}`));
  assert.equal(rendered.includes("gRPC instead"), false, "an unconfigured protocol is an honest omission");
  assert.equal(rendered.includes(OTLP_GRPC_ENDPOINT), false, "never a loopback beside a public endpoint");
});

test("display rule — both overridden: both render", () => {
  const configuredHttp = "https://ingest.example.com:4318";
  const configuredGrpc = "https://ingest.example.com:4317";
  const rendered = tabCode("otel", { http: configuredHttp, grpc: configuredGrpc });
  assert.ok(rendered.includes(`OTEL_EXPORTER_OTLP_ENDPOINT=${configuredHttp}`));
  assert.ok(rendered.includes(`# gRPC instead: ${configuredGrpc} with OTEL_EXPORTER_OTLP_PROTOCOL=grpc`));
});

// D282 — the gRPC-only corner, made symmetric: the SDK tabs (both HTTP-only
// exporters) render an honest absence that names the remedy variable, the
// OTel tab gets a REAL gRPC snippet, and no corner ever renders an empty
// export — an empty OTEL_EXPORTER_OTLP_ENDPOINT= makes the SDK silently fall
// back to localhost (measured), which is worse than an omission.
test("display rule — gRPC override alone (D282): SDK tabs go absent with the remedy named, the OTel tab speaks gRPC", () => {
  const grpcOnly = { http: null, grpc: "https://ingest.example.com:4317" };
  // The absence path: sdkTab drops the code and carries httpAbsence, whose
  // template must name the remedy variable and point at the working tab.
  const absenceIdx = source.indexOf("const httpAbsence =");
  assert.ok(absenceIdx > 0, "no httpAbsence in snippetsFor");
  const absenceBlock = source.slice(absenceIdx, source.indexOf(";", absenceIdx));
  assert.ok(
    absenceBlock.includes("OBSTACK_PUBLIC_OTLP_HTTP_ENDPOINT"),
    "the absence line must name the remedy variable",
  );
  assert.ok(
    absenceBlock.includes("I already have OTel"),
    "the absence line must point at the tab that still works",
  );
  const rendered = tabCode("otel", grpcOnly);
  assert.ok(rendered.includes(`OTEL_EXPORTER_OTLP_ENDPOINT=${grpcOnly.grpc}`));
  assert.ok(rendered.includes("OTEL_EXPORTER_OTLP_PROTOCOL=grpc"));
  assert.equal(rendered.includes(OTLP_HTTP_ENDPOINT), false, "never a loopback beside a public endpoint");
});

test("no corner renders an empty export (D282's class test)", () => {
  const corners: Array<{ http: string | null; grpc: string | null }> = [
    DEFAULT_ENDPOINTS,
    { http: "https://ingest.example.com:4318", grpc: null },
    { http: null, grpc: "https://ingest.example.com:4317" },
    { http: "https://ingest.example.com:4318", grpc: "https://ingest.example.com:4317" },
  ];
  for (const corner of corners) {
    for (const id of ["python", "typescript", "otel"]) {
      // The SDK tabs render an absence (no snippet at all) when HTTP is
      // unpublished — nothing to scan, and that is the point.
      if (!corner.http && id !== "otel") continue;
      const code = tabCode(id, corner);
      assert.equal(
        /^export [A-Z_]+=\s*$/m.test(code),
        false,
        `${id} rendered an empty export under ${JSON.stringify(corner)}`,
      );
    }
  }
});
