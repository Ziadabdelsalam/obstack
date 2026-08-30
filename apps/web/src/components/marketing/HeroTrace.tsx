"use client";

import { useState } from "react";
import { Sparkles } from "lucide-react";
import { Waterfall } from "@/components/trace/Waterfall";
import { SampleLabel } from "@/components/marketing/SampleLabel";
import { SAMPLE_COPY } from "@/components/marketing/sample-copy";
import { oomTrace } from "@/mock/stories";

const heroLogs = [
  { at: "+3.10s", sev: "warn", body: "memory pressure: rss 498MiB / limit 512Mi", solid: false },
  {
    at: "+4.21s",
    sev: "fatal",
    body: 'OOMKilled: container "app" exceeded memory limit (512Mi)',
    solid: false,
  },
  { at: "+4.23s", sev: "error", body: "draft_reply: stream aborted — connection reset by peer", solid: true },
];

/**
 * The landing's hero widget: `mock/stories.ts`'s OOM story, rendered by the
 * product's real `Waterfall`.
 *
 * D326 — every span, log line and trace id below is fabricated, and the caption
 * this component now renders BELOW itself is the only thing that says so. It
 * used to be a `<p>` in `app/page.tsx`, covered by a blanket footer line that
 * is gone; the label moved in here so the fabricated thing and its label are
 * one component and cannot be composed apart. The wording is D325's class 3,
 * and the shared half comes from `SAMPLE_COPY`: the caption called this an
 * actual incident until this sprint, and `sample` is the word that replaced it.
 */
export function HeroTrace() {
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <>
    <div className="overflow-hidden rounded-xl border border-line-strong bg-surface shadow-2xl">
      {/* window chrome */}
      <div className="flex items-center gap-2 border-b border-line px-3.5 py-2.5">
        <span className="flex gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-overlay" />
          <span className="h-2.5 w-2.5 rounded-full bg-overlay" />
          <span className="h-2.5 w-2.5 rounded-full bg-overlay" />
        </span>
        <span className="ml-2 font-mono text-[11px] text-faint">
          obstack · trace {oomTrace.id}
        </span>
        <span
          className="ml-auto flex items-center gap-1.5 rounded-[3px] px-1.5 py-0.5 font-mono text-[10px]"
          style={{
            color: "var(--color-err)",
            background: "color-mix(in srgb, var(--color-err) 12%, transparent)",
          }}
        >
          ● 502 · POST /v1/tickets/{"{id}"}/reply
        </span>
      </div>

      <div className="p-3">
        <Waterfall
          // R2 must-fix 1: the hero renders the OOM story WITHOUT its cluster
          // events. `oomTrace` carries them (`mock/stories.ts`), and
          // `infraTrackHeading` earns the second half of its heading from them
          // — so the real `Waterfall`, rendered here, printed that heading onto
          // the landing page transitively, past a sweep that reads this
          // directory's SOURCE and never the page a stranger receives. Nothing
          // in the live pipeline sets the field (`server/adapters.ts`), so a
          // marketing page whose heading names it is the capability claim D208
          // refuses; the fence's check (b) now reads the RENDERED html too, so
          // the next transitive one cannot hide the same way.
          //
          // The story itself is untouched: `/app/traces/*` still shows the
          // events, and the OOM evidence a stranger reads here is the pod row's
          // own marker and the three correlated log lines below.
          trace={{ ...oomTrace, k8sEvents: [] }}
          selectedId={selected}
          onSelect={setSelected}
          animate
        />
      </div>

      {/* correlated logs strip */}
      <div className="border-t border-line px-4 py-2.5">
        <p className="mb-1.5 font-mono text-[9.5px] uppercase tracking-widest text-faint">
          correlated logs · agent-worker-7d9fb-kx2rq
        </p>
        {heroLogs.map((l) => (
          <p key={l.at} className="flex items-baseline gap-2.5 py-[3px] font-mono text-[11px]">
            <span className="text-faint">{l.at}</span>
            <span
              className="uppercase"
              style={{ color: l.sev === "warn" ? "var(--color-warn)" : "var(--color-err)" }}
            >
              {l.sev}
            </span>
            <span
              className="truncate border-l-2 pl-2 text-mid"
              style={{
                borderColor: l.solid
                  ? "var(--color-infra)"
                  : "color-mix(in srgb, var(--color-infra) 30%, transparent)",
                borderLeftStyle: l.solid ? "solid" : "dashed",
              }}
            >
              {l.body}
            </span>
          </p>
        ))}
      </div>

      {/* explain teaser */}
      <div
        className="flex items-center gap-2.5 border-t px-4 py-3"
        style={{
          borderColor: "color-mix(in srgb, var(--color-llm) 30%, var(--color-line))",
          background: "color-mix(in srgb, var(--color-llm) 5%, transparent)",
        }}
      >
        <Sparkles className="h-4 w-4 shrink-0" style={{ color: "var(--color-llm)" }} />
        <p className="truncate text-[12.5px] text-mid">
          <span className="font-medium text-ink">Explain:</span> pod OOM-kill truncated the
        completion mid-stream — the 502 started three layers below it.
        </p>
      </div>
    </div>
    <SampleLabel className="mt-3 text-center">
      a sample failure, joined — {SAMPLE_COPY}: pod OOM-kill → truncated
      completion → failed agent step → 502
    </SampleLabel>
    </>
  );
}
