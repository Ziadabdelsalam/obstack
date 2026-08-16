"use client";

import { useState } from "react";

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
    blurb: "Core health plus your own watches — pin any service, pod, model, or pipeline.",
    src: "/shots/dashboard-widgets.png",
  },
  {
    id: "logs",
    label: "Logs",
    blurb: "Live tail across every pod, with each correlated line one click from its trace.",
    src: "/shots/logs-explorer.png",
  },
  {
    id: "connections",
    label: "Connections",
    blurb: "Every log source you run becomes a connection, not a silo.",
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
      <div className="overflow-hidden rounded-xl border border-line-strong shadow-2xl">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={active.src} alt={`obstack — ${active.label}`} className="block w-full" />
      </div>
    </div>
  );
}
