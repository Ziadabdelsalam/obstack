"use client";

import { useEffect, useState, useTransition, type ReactNode } from "react";
import Link from "next/link";
import { ArrowRight, Check, Copy } from "lucide-react";
import { StartTourButton } from "@/components/shell/TourGuide";
import { API_KEY_PLACEHOLDER } from "@/components/connections/connectors";
import { OTLP_GRPC_ENDPOINT, OTLP_HTTP_ENDPOINT } from "@/lib/ingest-endpoint";
import type { OnboardingStatus } from "@/server/onboarding";

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
 */
function snippetsFor(key: string) {
  return [
    {
      id: "python",
      label: "Python",
      code: `# the distribution is obstack-py; it imports as obstack
pip install './packages/obstack-py[fastapi]'

# app.py — these two lines go FIRST, above every other import
import obstack

obstack.init()  # no arguments: everything comes from the environment below

export OTEL_SERVICE_NAME=my-agent
export OTEL_EXPORTER_OTLP_ENDPOINT=${OTLP_HTTP_ENDPOINT}
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
export OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer%20${key}
# URL-encoded on purpose — a raw space drops the header.
# init() also defaults OTEL_SEMCONV_STABILITY_OPT_IN=http (Python only).`,
    },
    {
      id: "typescript",
      label: "TypeScript",
      code: `npm pack ./packages/obstack-js        # -> obstack-js-${OBSTACK_JS_VERSION}.tgz
npm install ./obstack-js-${OBSTACK_JS_VERSION}.tgz

// instrumentation.ts — before the libraries it instruments are imported
import { init } from "obstack-js";
init();

export OTEL_SERVICE_NAME=my-agent
export OTEL_EXPORTER_OTLP_ENDPOINT=${OTLP_HTTP_ENDPOINT}
export OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer%20${key}
# URL-encoded on purpose — a raw space drops the header.
# No OTEL_SEMCONV_STABILITY_OPT_IN here: obstack-js never reads it.`,
    },
    {
      id: "otel",
      label: "I already have OTel",
      code: `# no SDK, no code change — repoint the exporter you already run
export OTEL_EXPORTER_OTLP_ENDPOINT=${OTLP_HTTP_ENDPOINT}
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
export OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer%20${key}

# gRPC instead: ${OTLP_GRPC_ENDPOINT} with OTEL_EXPORTER_OTLP_PROTOCOL=grpc`,
    },
  ];
}

/**
 * What the server hands this component in live mode (D209 as amended by D215 —
 * the `endpoint` prop is gone: the endpoint is a constant both this file and the
 * connector steps import, not something threaded through a render).
 *
 * The two fields travel TOGETHER or not at all, which is what the union below
 * says in the type system: a live render has both, the demo deployment passes
 * its own arrival panel instead, and there is no third shape — a status with no
 * way to issue a key would render a waiting panel above snippets nobody can
 * fill. Which arm arrived is therefore the live/mock signal in this file, and it
 * is the same signal the page branches `dataMode` on one level up.
 *
 * The demo arm is a NODE rather than an import (D217): `DemoArrival` reaches the
 * demo's trace rows, so this file must not name that module — the mock-mode
 * caller does, and the live path keeps no edge to it at all.
 */
export type QuickstartLive = {
  initialStatus: OnboardingStatus;
  issueKey: (formData: FormData) => Promise<{ token: string }>;
  demoArrival?: never;
};

export type QuickstartProps =
  | QuickstartLive
  | { demoArrival: ReactNode; initialStatus?: never; issueKey?: never };

export function Quickstart(props: QuickstartProps) {
  const live: QuickstartLive | null = props.initialStatus === undefined ? null : props;
  const isLive = live !== null;

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

  const tabs = snippetsFor(token ?? API_KEY_PLACEHOLDER);
  const active = tabs.find((t) => t.id === tab)!;
  const copy = () => {
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
        <pre className="overflow-x-auto p-4 font-mono text-[12px] leading-relaxed text-mid">
          {active.code}
        </pre>
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
          auto-instrumentation is verified against, and `ai` 7 is named absent
          rather than left to be discovered. */}
      <p className="mt-2 font-mono text-[10.5px] text-faint">
        auto-instrumented, measured: openai &gt;=4.85 &lt;8 · @anthropic-ai/sdk &gt;=0.50 &lt;1 ·
        ai &gt;=5 &lt;7 — ai@7 is not yet supported (it emits no OTel span); streaming calls are not
        instrumented in either SDK
      </p>

      {/* waiting → first trace */}
      <div className="mt-6 rounded-lg border border-line bg-surface p-4">
        {live ? <LiveArrival status={status} /> : props.demoArrival}
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
function LiveArrival({ status }: { status: OnboardingStatus | null }) {
  const trace = status?.arrived ? status.firstTrace : null;
  if (!trace) {
    return (
      <div className="flex items-center gap-3 py-3">
        <span className="pulse-dot h-2 w-2 rounded-full" style={{ background: "var(--color-warn)" }} />
        <span className="font-mono text-[12.5px] text-mid">
          waiting for data<span className="pulse-dot">…</span>
        </span>
        <span className="ml-auto font-mono text-[11px] text-faint">
          listening on {OTLP_HTTP_ENDPOINT}
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
