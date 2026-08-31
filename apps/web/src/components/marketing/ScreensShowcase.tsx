"use client";

import { useState } from "react";
import { SampleLabel } from "@/components/marketing/SampleLabel";
import { SAMPLE_COPY } from "@/components/marketing/sample-copy";

const shots = [
  {
    id: "trace",
    label: "The pipeline trace",
    blurb: "Webhook → queue → agent → LLM → notify, one trace across five services and five pods.",
    src: "/shots/trace-pipeline.png",
  },
  {
    id: "dash",
    label: "Overview",
    // D325 class 5: the overview renders the four numbers `app/app/page.tsx`
    // computes. Pinnable widgets are a demo-only surface, so the blurb names
    // what the screen actually shows.
    blurb: "Requests, errors, latency and LLM cost for your workspace.",
    src: "/shots/dashboard-widgets.png",
  },
  {
    id: "logs",
    label: "Logs",
    // D325 class 6: the tail claim D48 killed in the product outlived it here,
    // in the one file `TourGuide.test.ts` had to allowlist. The allowlist is
    // empty as of this sprint and the sentence describes the search the surface
    // performs.
    blurb: "Search log bodies across every pod, each correlated line one click from its trace.",
    src: "/shots/logs-explorer.png",
  },
  {
    id: "connections",
    label: "Connections",
    // D325 class 4, the same sentence the connections wall carries: three of
    // the nineteen connectors are available and the catalog says so on its face.
    blurb: "Kubernetes, Docker and any OpenTelemetry source today; the rest of the catalog is listed as coming soon.",
    src: "/shots/connections.png",
  },
];

export function ScreensShowcase() {
  const [active, setActive] = useState(shots[0]);
  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {shots.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => setActive(s)}
            className="rounded-md border px-3 py-1.5 text-[12.5px] transition-colors"
            style={{
              borderColor:
                active.id === s.id
                  ? "color-mix(in srgb, var(--color-api) 50%, var(--color-line))"
                  : "var(--color-line)",
              color: active.id === s.id ? "var(--color-ink)" : "var(--color-mid)",
              background:
                active.id === s.id
                  ? "color-mix(in srgb, var(--color-api) 7%, transparent)"
                  : "var(--color-raised)",
            }}
          >
            {s.label}
          </button>
        ))}
      </div>
      <p className="mb-3 text-[13px] text-mid">{active.blurb}</p>
      {/* D326 — the four PNGs below are screenshots of the demo, which runs on
          the fabricated corpus. They carry the shell's DEMO WORKSPACE bar in
          their own pixels, but a reader of the landing page is owed the label
          in text as well, above the image rather than under it. */}
      <SampleLabel className="mb-2">
        screenshots of the demo — {SAMPLE_COPY}
      </SampleLabel>
      <div className="overflow-hidden rounded-xl border border-line-strong shadow-2xl">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={active.src} alt={`obstack — ${active.label}`} className="block w-full" />
      </div>
    </div>
  );
}
