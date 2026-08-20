"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Search } from "lucide-react";
import type { ConnectedSource } from "@/mock/types";
import { categories, connectors, type Connector } from "./connectors";
import { ConnectModal } from "./ConnectModal";

const sourceStatus: Record<
  ConnectedSource["status"],
  { color: string; label: string }
> = {
  healthy: { color: "var(--color-ok)", label: "healthy" },
  degraded: { color: "var(--color-warn)", label: "degraded" },
  silent: { color: "var(--color-err)", label: "no events" },
};

/**
 * One of the workspace's keys, as the connected panel receives it — the D100
 * `api_key_health` row and nothing else (the ONE counter path: this surface
 * never queries spans to count them a second way).
 *
 * The drop counts arrive RAW and are classified here rather than by the page,
 * so the classification is one pure function this file's test drives directly;
 * the page's job is the workspace scope and the date formatting, which is where
 * every other live surface puts them (settings/page.tsx).
 */
export interface LiveSource {
  keyId: string;
  name: string;
  prefix: string;
  revoked: boolean;
  accepted: number;
  droppedDecode: number;
  droppedUnsupported: number;
  droppedQuota: number;
  /** Formatted on the server, like every other rendered instant. Null = never. */
  lastEvent: string | null;
}

/**
 * What fills the connected panel. The two modes are one prop rather than two
 * components because the catalog below the panel is identical in both (D204/
 * D208) — only the panel differs, and the mode that decides it is the page's
 * (`dataMode`), never this component's guess.
 *
 * The demo rows stay fabricated sample data (D208) and reach this file as props:
 * a live surface does not import `@/mock/connectors`.
 */
export type ConnectedPanel =
  | { mode: "live"; sources: LiveSource[]; asOf: string | null }
  | { mode: "demo"; sources: ConnectedSource[] };

/** Receive-path errors: decode plus unsupported, and deliberately NOT quota
 *  drops — a sampled-out record is the degradation the plan bought, and summing
 *  the two would tell an operator their exporter is broken while it is working
 *  exactly as designed (the basis `server/ingest-health.ts` states, D162). */
export function sourceErrors(source: LiveSource): number {
  return source.droppedDecode + source.droppedUnsupported;
}

/**
 * A key is a connected SOURCE once something has arrived on it. A key that has
 * never carried an event is not a source anyone connected — it is a credential,
 * and the keys tab in settings is where credentials are listed. Filtering here
 * is what makes the empty state honest: "no sources yet" means no key of this
 * workspace has ever carried an event, not "no rows in the table".
 */
export function connectedSourcesOf(sources: LiveSource[]): LiveSource[] {
  return sources.filter((source) => source.lastEvent !== null);
}

/** Live rows carry no `silent`: a source only appears once it has events. A
 *  revoked key that carried some is listed and SAID to be revoked — the events
 *  happened, and the key no longer works. */
export function liveSourceStatus(source: LiveSource): "healthy" | "degraded" | "revoked" {
  if (source.revoked) return "revoked";
  return sourceErrors(source) > 0 ? "degraded" : "healthy";
}

const liveStatusStyle: Record<
  ReturnType<typeof liveSourceStatus>,
  { color: string; label: string }
> = {
  healthy: { color: "var(--color-ok)", label: "healthy" },
  degraded: { color: "var(--color-warn)", label: "receive errors" },
  revoked: { color: "var(--color-err)", label: "revoked" },
};

export function ConnectionsHub({ data }: { data: ConnectedPanel }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Connector | null>(null);

  const filtered = useMemo(
    () =>
      connectors.filter(
        (c) =>
          c.name.toLowerCase().includes(q.toLowerCase()) ||
          c.category.toLowerCase().includes(q.toLowerCase()) ||
          c.blurb.toLowerCase().includes(q.toLowerCase()),
      ),
    [q],
  );

  const bySlug = new Map(connectors.map((c) => [c.slug, c]));

  // Live: only the keys something has arrived on (a key with no events is a
  // credential, not a connected source). Demo: the sample rows as given.
  const connected =
    data.mode === "live" ? connectedSourcesOf(data.sources) : data.sources;

  return (
    <div className="px-5 py-4">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-[19px] font-semibold text-ink">Connections</h1>
          <p className="mt-0.5 text-[12.5px] text-mid">
            Every source of logs and traces you run, wired into one place.
          </p>
        </div>
        <div className="relative w-64">
          <Search className="absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-faint" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search sources…"
            className="w-full rounded-md border border-line bg-surface py-1.5 pr-3 pl-8 text-[13px] text-ink placeholder:text-faint focus:border-line-strong focus:outline-none"
          />
        </div>
      </div>

      {/* connected sources — live: this workspace's keys and what has actually
          arrived on them; demo: the fabricated sample rows (D208). The tour
          anchor stays on this section through the rewrite (D212). */}
      <section className="mb-6 rounded-lg border border-line bg-surface" data-tour="connections">
        <div className="border-b border-line px-3.5 py-2">
          <h2 className="font-mono text-[11px] uppercase tracking-widest text-faint">
            connected · {connected.length}
          </h2>
        </div>
        {data.mode === "live" ? (
          connected.length === 0 ? (
            /* Not a zero row and not an empty table: what is missing, and the
               two things that end it (D142). A workspace lands here with keys
               it has issued and nothing sent on them, so the sentence is about
               events, not about keys. */
            <div className="px-3.5 py-5">
              <p className="text-[13px] text-ink">No sources yet.</p>
              <p className="mt-1 max-w-prose text-[12.5px] leading-relaxed text-mid">
                Nothing has reached this workspace on any key. Issue one in the{" "}
                <Link href="/app/onboarding" className="text-ink underline underline-offset-2">
                  Quickstart
                </Link>{" "}
                and follow a connect flow below — the first accepted event fills this panel with
                what carried it and when.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-line/50">
              {(connected as LiveSource[]).map((s) => {
                const st = liveStatusStyle[liveSourceStatus(s)];
                const errors = sourceErrors(s);
                return (
                  <div
                    key={s.keyId}
                    className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3.5 py-2.5"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] text-ink">{s.name}</p>
                      <p className="font-mono text-[10.5px] text-faint">{s.prefix}…</p>
                    </div>
                    <span
                      className="flex items-center gap-1.5 font-mono text-[11px]"
                      style={{ color: st.color }}
                    >
                      <span
                        className="pulse-dot h-1.5 w-1.5 rounded-full"
                        style={{ background: st.color }}
                      />
                      {st.label}
                    </span>
                    <span className="w-32 text-right font-mono text-[11px] text-mid">
                      {s.accepted.toLocaleString("en-US")} accepted
                    </span>
                    <span className="w-24 text-right font-mono text-[11px] text-faint">
                      {s.droppedQuota.toLocaleString("en-US")} sampled
                    </span>
                    <span className="w-40 text-right font-mono text-[11px] text-faint">
                      last event {s.lastEvent}
                    </span>
                    <span
                      className="w-16 text-right font-mono text-[11px]"
                      style={{ color: errors ? "var(--color-warn)" : "var(--color-faint)" }}
                    >
                      {errors.toLocaleString("en-US")} errs
                    </span>
                  </div>
                );
              })}
            </div>
          )
        ) : (
          <div className="divide-y divide-line/50">
            {(connected as ConnectedSource[]).map((s) => {
              const c = bySlug.get(s.connectorSlug);
              const st = sourceStatus[s.status];
              return (
                <div
                  key={s.name}
                  className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3.5 py-2.5"
                >
                  <span
                    className="flex h-7 w-7 items-center justify-center rounded-md border border-line bg-raised font-mono text-[10.5px] font-semibold"
                    style={{ color: c?.markColor }}
                  >
                    {c?.mark}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] text-ink">{s.name}</p>
                    <p className="font-mono text-[10.5px] text-faint">{c?.name}</p>
                  </div>
                  <span
                    className="flex items-center gap-1.5 font-mono text-[11px]"
                    style={{ color: st.color }}
                  >
                    <span
                      className="pulse-dot h-1.5 w-1.5 rounded-full"
                      style={{ background: st.color }}
                    />
                    {st.label}
                  </span>
                  <span className="w-24 text-right font-mono text-[11px] text-mid">
                    {s.ratePerMin.toLocaleString()}/min
                  </span>
                  <span className="w-20 text-right font-mono text-[11px] text-faint">
                    {s.lastEvent}
                  </span>
                  <span
                    className="w-16 text-right font-mono text-[11px]"
                    style={{ color: s.errorCount ? "var(--color-warn)" : "var(--color-faint)" }}
                  >
                    {s.errorCount ? `${s.errorCount} errs` : "0 errs"}
                  </span>
                </div>
              );
            })}
          </div>
        )}
        {data.mode === "live" && (
          /* The one staleness statement (D162), on the surface that shows the
             numbers: these are cumulative per-key counters written by the
             metering flush, so they are seconds behind and they are not a rate. */
          <p className="border-t border-line px-3.5 py-2 font-mono text-[10.5px] leading-relaxed text-faint">
            {data.asOf
              ? `counts are cumulative per key, as of ${data.asOf} — errors are receive-path only; sampled records are the plan's quota, not a fault`
              : "no events on any key yet — these counts start with the first accepted record"}
          </p>
        )}
      </section>

      {/* catalog */}
      {categories.map((cat) => {
        const items = filtered.filter((c) => c.category === cat);
        if (items.length === 0) return null;
        return (
          <section key={cat} className="mb-6">
            <h2 className="mb-2 font-mono text-[11px] uppercase tracking-widest text-faint">
              {cat}
            </h2>
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
              {items.map((c) => (
                <button
                  key={c.slug}
                  type="button"
                  onClick={() => setOpen(c)}
                  className="group flex items-start gap-3 rounded-lg border border-line bg-surface p-3 text-left transition-colors hover:border-line-strong hover:bg-raised"
                >
                  <span
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-line bg-raised font-mono text-[13px] font-semibold"
                    style={{ color: c.markColor }}
                  >
                    {c.mark}
                  </span>
                  <span className="min-w-0">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-[13px] font-medium text-ink">{c.name}</span>
                      {c.status === "available" ? (
                        <span
                          className="rounded-[3px] px-1 py-px font-mono text-[9px] tracking-wide"
                          style={{
                            color: "var(--color-ok)",
                            background: "color-mix(in srgb, var(--color-ok) 12%, transparent)",
                          }}
                        >
                          CONNECT
                        </span>
                      ) : (
                        <span className="rounded-[3px] bg-overlay px-1 py-px font-mono text-[9px] tracking-wide text-faint">
                          SOON
                        </span>
                      )}
                    </span>
                    <span className="mt-0.5 block text-[12px] leading-snug text-mid">
                      {c.blurb}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </section>
        );
      })}

      {filtered.length === 0 && (
        <p className="py-10 text-center text-[13px] text-faint">
          No sources match “{q}”. Try a different name, or request it — the catalog grows by demand.
        </p>
      )}

      {open && <ConnectModal connector={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
