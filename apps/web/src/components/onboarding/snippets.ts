/**
 * THE quickstart snippets, in one module (D322).
 *
 * These three tabs are rendered in two places now — the in-app quickstart
 * (`Quickstart.tsx`, the client component that fills the token slot with a key
 * the operator just issued) and the docs page
 * (`@/components/docs/QuickstartSnippets`, a server component rendering all
 * three stacked for MDX at the compose defaults). A second copy of the strings
 * in the docs corpus would be a second definition of the install a stranger
 * pastes into a terminal, going stale silently the first time an SDK moves;
 * `Quickstart.test.ts` therefore reads THIS file for the byte-check and also
 * asserts that no line of `src/content/**` carries one of these commands.
 *
 * PURE by construction: no client directive, no hooks, no imports at all. A
 * client component and a server component both import it, which only works
 * while it stays a function over its arguments — and `Quickstart.test.ts`
 * reads this file and fails on any of the three, deliberately without spelling
 * the directive here (the D246 discipline: a sweep's needles do not appear in
 * the files it sweeps).
 *
 * Moved here VERBATIM from `Quickstart.tsx` — the rendered output is
 * byte-identical, which is the whole point of the move.
 */

/** What every snippet on this page interpolates for the endpoint (D266/D277):
 * `null` means "omit this protocol" (the display rule below), never "fall
 * back to the loopback default" — that fallback only happens once, at the
 * top of this component, for the arm that carries no resolved pair at all. */
export type ResolvedEndpoints = { http: string | null; grpc: string | null };

/**
 * The version `npm pack` writes, mirrored from `packages/obstack-js/package.json`
 * and pinned by `Quickstart.test.ts` — the install line names a file that has to
 * exist after the pack, so a version bump that missed this line would print a
 * command nobody can run.
 */
const OBSTACK_JS_VERSION = "0.1.0";

/**
 * Every snippet on this page, with ONE token slot filled in one place.
 *
 * The lines are the two SDK READMEs' own, verbatim (D101/D202): the packages
 * that exist (`obstack-py`, `obstack-js`) installed the way they actually
 * install today — from this repo — and the frozen D78 API, which is `init()`
 * with NO arguments in both languages, configured entirely from the standard
 * `OTEL_*` environment. Neither SDK takes an `api_key`; the key travels in
 * `OTEL_EXPORTER_OTLP_HEADERS`, URL-encoded, because the OTel SDKs drop a header
 * value containing a raw space.
 *
 * The Python block carries `OTEL_EXPORTER_OTLP_PROTOCOL` and the
 * `OTEL_SEMCONV_STABILITY_OPT_IN` note; the TypeScript block carries neither,
 * and that asymmetry is deliberate — obstack-js builds its exporters itself
 * (always OTLP protobuf over HTTP) and never consults the semconv variable, so
 * copying Python's line across is exactly what its README warns against.
 *
 * `endpoints` is HTTP as primary (D266), and the display rule is symmetric
 * (D277/D282): a tab that needs a protocol this deployment does not publish
 * renders an honest absence NAMING THE REMEDY — never an empty export,
 * because an empty `OTEL_EXPORTER_OTLP_ENDPOINT=` makes the OTel SDK silently
 * fall back to localhost (measured), which is a worse lie than an omission.
 * Both SDK tabs need HTTP (obstack-py exports http/protobuf; obstack-js
 * always builds HTTP exporters); the "I already have OTel" tab can speak
 * either, so a gRPC-only deployment still gets a real, complete snippet
 * there. No override → both loopback defaults, byte-identical to every
 * checkout; any override → only what was actually configured renders.
 */
export function snippetsFor(key: string, endpoints: ResolvedEndpoints) {
  const { http, grpc } = endpoints;
  const grpcLine = grpc
    ? `\n\n# gRPC instead: ${grpc} with OTEL_EXPORTER_OTLP_PROTOCOL=grpc`
    : "";
  // Reachable only under a gRPC-only override: the resolver returns both
  // defaults when nothing is set, so `http === null` implies `grpc` is real.
  const httpAbsence =
    `This deployment publishes only a gRPC endpoint (${grpc}). This SDK exports OTLP over ` +
    `HTTP, so there is no HTTP setup to copy here — set OBSTACK_PUBLIC_OTLP_HTTP_ENDPOINT ` +
    `on the web workload to render it. The "I already have OTel" tab has the gRPC setup.`;
  const sdkTab = (id: string, label: string, code: string) =>
    http
      ? { id, label, code, absence: null as string | null }
      : { id, label, code: null as string | null, absence: httpAbsence };
  return [
    sdkTab(
      "python",
      "Python",
      `# the distribution is obstack-py; it imports as obstack
pip install './packages/obstack-py[fastapi]'

# app.py — these two lines go FIRST, above every other import
import obstack

obstack.init()  # no arguments: everything comes from the environment below

export OTEL_SERVICE_NAME=my-agent
export OTEL_EXPORTER_OTLP_ENDPOINT=${http}
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
export OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer%20${key}
# URL-encoded on purpose — a raw space drops the header.
# init() also defaults OTEL_SEMCONV_STABILITY_OPT_IN=http (Python only).`,
    ),
    sdkTab(
      "typescript",
      "TypeScript",
      `# pack from the obstack repo root; install from your app's directory
npm pack ./packages/obstack-js        # -> obstack-js-${OBSTACK_JS_VERSION}.tgz
npm install ./obstack-js-${OBSTACK_JS_VERSION}.tgz

// instrumentation.ts — before the libraries it instruments are imported
import { init } from "obstack-js";
init();

export OTEL_SERVICE_NAME=my-agent
export OTEL_EXPORTER_OTLP_ENDPOINT=${http}
export OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer%20${key}
# URL-encoded on purpose — a raw space drops the header.
# No OTEL_SEMCONV_STABILITY_OPT_IN here: obstack-js never reads it.`,
    ),
    {
      id: "otel",
      label: "I already have OTel",
      // Any OTel exporter speaks either protocol, so this tab always has a
      // real snippet: HTTP when the deployment publishes it, gRPC otherwise
      // (D282 — never an empty export, never a protocol nothing serves).
      code: http
        ? `# no SDK, no code change — repoint the exporter you already run
export OTEL_EXPORTER_OTLP_ENDPOINT=${http}
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
export OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer%20${key}${grpcLine}`
        : `# no SDK, no code change — repoint the exporter you already run
export OTEL_EXPORTER_OTLP_ENDPOINT=${grpc}
export OTEL_EXPORTER_OTLP_PROTOCOL=grpc
export OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer%20${key}`,
      absence: null as string | null,
    },
  ];
}
