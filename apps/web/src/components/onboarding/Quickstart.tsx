"use client";

import { useEffect, useState, useTransition, type ReactNode } from "react";
import Link from "next/link";
import { ArrowRight, Check, Copy } from "lucide-react";
import { StartTourButton } from "@/components/shell/TourGuide";
import { API_KEY_PLACEHOLDER } from "@/components/connections/connectors";
import { OTLP_GRPC_ENDPOINT, OTLP_HTTP_ENDPOINT } from "@/lib/ingest-endpoint";
import type { OnboardingStatus } from "@/server/onboarding";

/** What every snippet on this page interpolates for the endpoint (D266/D277):
 * `null` means "omit this protocol" (the display rule below), never "fall
 * back to the loopback default" — that fallback only happens once, at the
 * top of this component, for the arm that carries no resolved pair at all. */
type ResolvedEndpoints = { http: string | null; grpc: string | null };

/**
 * The version `npm pack` writes, mirrored from `packages/obstack-js/package.json`
 * and pinned by `Quickstart.test.ts` — the install line names a file that has to
 * exist after the pack, so a version bump that missed this line would print a
 * command nobody can run.
 */
const OBSTACK_JS_VERSION = "0.1.0";

/** The poll cadence: the counters behind the status flush every 5s (D203). */
const POLL_MS = 5_000;

/** The GET handler beside the page (D203) — a read is a read (D189). */
const STATUS_PATH = "/app/onboarding/status";

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
function snippetsFor(key: string, endpoints: ResolvedEndpoints) {
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
      `npm pack ./packages/obstack-js        # -> obstack-js-${OBSTACK_JS_VERSION}.tgz
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

/**
 * What the server hands this component in live mode (D209, amended by D277 —
 * the `endpoint` prop is back, reshaped: D215 deleted it because the address
 * was one hardcoded constant with nothing to configure; M4 gives operators a
 * real override, and an override is per-request server state, not a constant
 * this file can import. `endpoints` is `resolveIngestEndpoints()`'s result
 * (`@/server/ingest-endpoint`, D266) passed down as props — this file is
 * `"use client"` and that resolver's module carries `import "server-only"`,
 * which a client component cannot import.
 *
 * The three live fields travel TOGETHER or not at all, which is what the union
 * below says in the type system: a live render has all three, the demo
 * deployment passes its own arrival panel instead, and there is no third shape
 * — a status with no way to issue a key would render a waiting panel above
 * snippets nobody can fill. Which arm arrived is therefore the live/mock
 * signal in this file, and it is the same signal the page branches `dataMode`
 * on one level up. The demo arm carries no `endpoints` of its own: the demo
 * deployment has no configurable ingest to override, so its snippets fall back
 * to the loopback defaults below (D266: "mock/demo copy byte-identical").
 *
 * The demo arm is a NODE rather than an import (D217): `DemoArrival` reaches the
 * demo's trace rows, so this file must not name that module — the mock-mode
 * caller does, and the live path keeps no edge to it at all.
 */
export type QuickstartLive = {
  initialStatus: OnboardingStatus;
  issueKey: (formData: FormData) => Promise<{ token: string }>;
  demoArrival?: never;
  endpoints: ResolvedEndpoints;
};

export type QuickstartProps =
  | QuickstartLive
  | { demoArrival: ReactNode; initialStatus?: never; issueKey?: never; endpoints?: never };

export function Quickstart(props: QuickstartProps) {
  const live: QuickstartLive | null = props.initialStatus === undefined ? null : props;
  const isLive = live !== null;

  // No `endpoints` prop (the demo arm) falls back to the same two client-safe
  // constants the rest of this module always imported — byte-identical to
  // every checkout before D266/D277 (the mirror test on `resolveIngestEndpoints`
  // asserts the live arm's no-override case matches these too).
  const endpoints: ResolvedEndpoints = live?.endpoints ?? {
    http: OTLP_HTTP_ENDPOINT,
    grpc: OTLP_GRPC_ENDPOINT,
  };

  const [tab, setTab] = useState("python");
  const [copied, setCopied] = useState(false);

  /**
   * The issued token, D201: client state and nothing else. It is never written
   * to storage, never put in a URL and never sent back to the server — it exists
   * in this component's state until the page unmounts, which is the whole
   * lifetime a shown-once key (D98) honestly has.
   */
  const [token, setToken] = useState<string | null>(null);
  const [issuing, startIssuing] = useTransition();

  const [status, setStatus] = useState<OnboardingStatus | null>(live?.initialStatus ?? null);
  const linked = Boolean(status?.arrived && status.firstTrace);

  // Live arrival: poll the GET handler at the counters' own cadence until the
  // workspace's first trace is linkable, then stop asking (D203). Any non-200
  // stops it too (D216) — a 401 means the session is gone and a 404 means this
  // deployment has no such route, and neither improves by being asked again in
  // five seconds. A thrown fetch is a transient network blip and is left alone.
  useEffect(() => {
    if (!isLive || linked) return;
    let stopped = false;
    const id = setInterval(async () => {
      const response = await fetch(STATUS_PATH, { cache: "no-store" }).catch(() => null);
      if (!response || stopped) return;
      if (!response.ok) {
        stopped = true;
        clearInterval(id);
        return;
      }
      setStatus((await response.json()) as OnboardingStatus);
    }, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [isLive, linked]);

  const tabs = snippetsFor(token ?? API_KEY_PLACEHOLDER, endpoints);
  const active = tabs.find((t) => t.id === tab)!;
  const copy = () => {
    if (active.code === null) return;
    navigator.clipboard.writeText(active.code).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const issue = (formData: FormData) =>
    startIssuing(async () => {
      // `?.` because a REFUSED issue never returns a value: the action redirects
      // (settings' `issueKey` note explains the same shape).
      const result = await live?.issueKey(formData);
      setToken(result?.token ?? null);
    });

  return (
    <div className="mx-auto max-w-2xl px-5 py-8">
      <h1 className="font-display text-[22px] font-semibold text-ink">
        Get your first trace
      </h1>
      <p className="mt-1 text-[13.5px] text-mid">
        Median time from here to a correlated trace: under 15 minutes.{" "}
        {live
          ? `Issue a key below and every snippet on this page carries it in place of ${API_KEY_PLACEHOLDER}.`
          : `The snippets carry the ${API_KEY_PLACEHOLDER} slot — a real deployment issues the key on this page.`}
      </p>
      <div className="mt-4">
        <StartTourButton variant="big" />
        <p className="mt-1.5 font-mono text-[10.5px] text-faint">
          new here? the tour walks every screen with the demo incident as the thread — ~3 minutes
        </p>
      </div>

      {/* tabs */}
      <div className="mt-5 flex gap-1 border-b border-line">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`-mb-px rounded-t-md border-b-2 px-3.5 py-2 text-[13px] transition-colors ${
              tab === t.id
                ? "border-current text-ink"
                : "border-transparent text-faint hover:text-mid"
            }`}
            style={tab === t.id ? { borderBottomColor: "var(--color-api)" } : undefined}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="group relative rounded-b-lg border border-t-0 border-line bg-surface">
        {/* D282: an unpublished protocol renders its honest absence — a plain
            sentence naming the remedy, with nothing to copy — never a snippet
            with an empty export. */}
        {active.absence !== null ? (
          <p className="p-4 text-[12.5px] leading-relaxed text-mid">{active.absence}</p>
        ) : (
        <pre className="overflow-x-auto p-4 font-mono text-[12px] leading-relaxed text-mid">
          {active.code}
        </pre>
        )}
        {active.absence === null && (
        <button
          type="button"
          onClick={copy}
          aria-label="Copy snippet"
          className="absolute top-3 right-3 rounded border border-line bg-raised p-1.5 text-faint hover:text-ink"
        >
          {copied ? (
            <Check className="h-3.5 w-3.5" style={{ color: "var(--color-ok)" }} />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
        </button>
        )}
      </div>

      {/*
        The one caveat, stated once (D202): neither package is released, the
        registry names are held (U5) rather than usable, and the lines above are
        the install that works today — from this repo.
      */}
      <p className="mt-2.5 font-mono text-[10.5px] text-faint">
        pre-release: obstack-py and obstack-js install from this repo — the registry names are
        reserved and the real releases publish at launch
      </p>

      {/* D201: the key the snippets carry, issued here because a stored token is
          unrecoverable by design (D98) — a prefix is not something anyone pastes. */}
      {live && (
        <div className="mt-3 rounded-lg border border-line bg-surface p-3.5">
          {token ? (
            <p className="flex items-center gap-2 text-[12.5px] text-mid">
              <Check className="h-3.5 w-3.5 shrink-0" style={{ color: "var(--color-ok)" }} />
              Key issued and pasted into the snippets above. It is shown once — copy a snippet now;
              reloading this page cannot bring it back.
            </p>
          ) : (
            <form action={issue} className="flex flex-wrap items-center gap-3">
              <button
                type="submit"
                disabled={issuing}
                className="rounded-md border border-line bg-raised px-3 py-1.5 text-[13px] text-ink hover:border-line-strong disabled:opacity-60"
              >
                {issuing ? "issuing…" : "Issue a key"}
              </button>
              <span className="text-[12.5px] text-faint">
                shown once, in the snippets above — it is stored hashed and cannot be read back
              </span>
            </form>
          )}
        </div>
      )}

      <p className="mt-3 text-[12.5px] text-faint">
        Shipping on Docker or Kubernetes? Add the{" "}
        <Link href="/app/connections" className="text-mid underline decoration-line underline-offset-2 hover:text-ink">
          collector
        </Link>{" "}
        too — that&apos;s what joins container logs to these traces.
      </p>

      {/* The measured fence, not a promise (D88/D101): these are the ranges the
          auto-instrumentation is verified against, and what each SDK needs from
          the caller is named rather than left to be discovered. */}
      <p className="mt-2 font-mono text-[10.5px] text-faint">
        auto-instrumented, measured: openai &gt;=4.85 &lt;8 (the Responses API from 4.87) ·
        @anthropic-ai/sdk &gt;=0.50 &lt;1 · ai &gt;=5 &lt;8 — on ai@7 telemetry is on by
        default, on ai@5 and 6 pass {"experimental_telemetry: { isEnabled: true }"}; streaming calls
        are not instrumented for any of the three
      </p>

      {/* waiting → first trace */}
      <div className="mt-6 rounded-lg border border-line bg-surface p-4">
        {live ? <LiveArrival status={status} endpoints={endpoints} /> : props.demoArrival}
      </div>
    </div>
  );
}

/**
 * The real panel: the workspace's own counters said data arrived and the scoped
 * search resolved the trace to link (D203). "arrived but no link yet" is the
 * flush window, and it keeps waiting — a link to a trace that 404s would be
 * worse than the spinner.
 */
function LiveArrival({
  status,
  endpoints,
}: {
  status: OnboardingStatus | null;
  endpoints: ResolvedEndpoints;
}) {
  // D282: the waiting line names the endpoint(s) this deployment actually
  // publishes — never a bare "listening on " stub. `http ?? grpc` is total:
  // the resolver never returns both null.
  const listening = endpoints.http ?? `${endpoints.grpc} (grpc)`;
  const trace = status?.arrived ? status.firstTrace : null;
  if (!trace) {
    return (
      <div className="flex items-center gap-3 py-3">
        <span className="pulse-dot h-2 w-2 rounded-full" style={{ background: "var(--color-warn)" }} />
        <span className="font-mono text-[12.5px] text-mid">
          waiting for data<span className="pulse-dot">…</span>
        </span>
        <span className="ml-auto font-mono text-[11px] text-faint">
          listening on {listening}
          {status?.asOf ? ` · as of ${status.asOf}` : ""}
        </span>
      </div>
    );
  }
  return (
    <div className="fade-up">
      <p className="mb-2 flex items-center gap-2 font-mono text-[11px] uppercase tracking-widest" style={{ color: "var(--color-ok)" }}>
        <Check className="h-3.5 w-3.5" /> first trace received
      </p>
      <Link
        href={`/app/traces/${trace.id}`}
        className="flex items-center justify-between rounded-md border border-line bg-raised px-3 py-2.5 transition-colors hover:border-line-strong"
      >
        <span className="truncate font-mono text-[12.5px] text-ink">{trace.id}</span>
        <ArrowRight className="h-3.5 w-3.5 shrink-0" style={{ color: "var(--color-api)" }} />
      </Link>
    </div>
  );
}
