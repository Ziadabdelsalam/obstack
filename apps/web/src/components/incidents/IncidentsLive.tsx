import Link from "next/link";
import {
  formatIncidentWindow,
  type IncidentRow,
  type IncidentSeverity,
  type IncidentStatus,
  type PromotableAlertEvent,
} from "@/lib/incident-types";
import { IncidentCardControls, NewIncidentButton } from "./IncidentEditor";

/**
 * Incidents, live (S7.4 T6, D519/D545/D546): a SERVER component fed
 * exclusively by `server/incidents.ts` through `incidents/page.tsx`. No
 * `@/mock/` import anywhere in this file, and nothing from `@/server/*` — the
 * page reads, this file renders what it was handed.
 *
 * In live this URL is a LIST; in mock it is the frozen demo's one incident
 * (D521 names that divergence rather than deriving it away). Every row this
 * workspace holds is here — the read has no LIMIT because the per-workspace
 * cap is the bound (D529) — so the header is DERIVED from the read itself,
 * `{ongoing} ongoing · {total} total`, and never the mock's seven-day sentence:
 * the read applies no time predicate, and that sentence would be a claim
 * about a filter that does not exist (D545).
 *
 * The "from an alert" mark reads `origin`, NEVER the nullable event pointer:
 * `opened_from_event_id` is `ON DELETE SET NULL`, and the referenced
 * `alert_events` row goes away on the sweeper's 7-day clock (D526) — and also,
 * measured against `0012_slos.sql:62`, when its SLO is deleted (`slo_id … ON
 * DELETE CASCADE`). So a null pointer is worded as a bound ("the event is no
 * longer held") and not as a cause ("aged out"), which is only one of the two.
 *
 * `data-tour="incident"` is on the HEADER ROW, present with zero incidents: a
 * zero-incident workspace renders no card, and `TourGuide.tsx`'s
 * missing-anchor path degrades silently to bottom-centre (D523, the D404
 * class). The same anchor survives inside the frozen mock body.
 *
 * The style tables are this file's own: the mock page's cannot move without
 * breaking its byte pin, the VOCABULARIES have one definition each
 * (`IncidentStatus`, `IncidentSeverity` in `lib/incident-types.ts`), and the
 * styling may exist twice. The severity table carries `info`, the member the
 * fixture never used (D525 — the S7.3 `no-data` precedent).
 */
const statusStyle: Record<IncidentStatus, { color: string; label: string }> = {
  ongoing: { color: "var(--color-err)", label: "ONGOING" },
  resolved: { color: "var(--color-ok)", label: "RESOLVED" },
};

const severityStyle: Record<IncidentSeverity, { color: string; label: string }> = {
  critical: { color: "var(--color-err)", label: "CRITICAL" },
  warning: { color: "var(--color-warn)", label: "WARNING" },
  info: { color: "var(--color-mid)", label: "INFO" },
};

const PILL = "rounded-[3px] px-1.5 py-px font-mono text-[9.5px] tracking-wide";

/** Every status pill in the live graph goes through the table — never a literal text node. */
export function IncidentStatusPill({ status }: { status: IncidentStatus }) {
  const st = statusStyle[status];
  return (
    <span className={PILL} style={{ color: st.color, background: `color-mix(in srgb, ${st.color} 12%, transparent)` }}>
      {st.label}
    </span>
  );
}

export function IncidentSeverityPill({ severity }: { severity: IncidentSeverity }) {
  const sv = severityStyle[severity];
  return (
    <span className={PILL} style={{ color: sv.color, background: `color-mix(in srgb, ${sv.color} 12%, transparent)` }}>
      {sv.label}
    </span>
  );
}

/** The origin mark (D526): rendered off `origin`, worded off the pointer only
 *  to say whether the event is still held — never to say why it is not. */
export function IncidentOriginMark({ incident }: { incident: IncidentRow }) {
  if (incident.origin !== "alert") return null;
  return (
    <span className="font-mono text-[10.5px] text-faint">
      from an alert{incident.openedFromEventId === null && " · the event is no longer held"}
    </span>
  );
}

export function IncidentsLive({
  incidents,
  total,
  ongoing,
  promotable,
  nowMs,
}: {
  incidents: IncidentRow[];
  /** Both counted by the list read in the same pass (D545). */
  total: number;
  ongoing: number;
  /** The promote picker's options — bounded by a module constant on the page, never a client number. */
  promotable: PromotableAlertEvent[];
  /** The render's one clock, for the ongoing durations (D50/D64). */
  nowMs: number;
}) {
  return (
    <div className="mx-auto max-w-3xl px-5 py-4">
      <div className="mb-4 flex items-start justify-between gap-3" data-tour="incident">
        <div>
          <h1 className="font-display text-[19px] font-semibold text-ink">Incidents</h1>
          <p className="mt-0.5 font-mono text-[11px] text-faint">{`${ongoing} ongoing · ${total} total`}</p>
        </div>
        <NewIncidentButton promotable={promotable} />
      </div>

      {incidents.length === 0 ? (
        <div className="rounded-lg border border-line bg-surface p-6 text-center">
          <p className="font-mono text-[13px] text-mid">no incidents yet — declare one, or promote an alert event</p>
        </div>
      ) : (
        <div className="grid gap-3">
          {incidents.map((i) => (
            <section
              key={i.id}
              className="rounded-lg border bg-surface"
              style={{
                borderColor:
                  i.status === "ongoing"
                    ? `color-mix(in srgb, ${statusStyle.ongoing.color} 40%, var(--color-line))`
                    : "var(--color-line)",
              }}
            >
              <Link href={`/app/incidents/${i.id}`} className="block p-4 hover:bg-raised">
                <div className="flex flex-wrap items-center gap-2.5">
                  <span className="font-mono text-[12px] text-faint">{i.id}</span>
                  <IncidentStatusPill status={i.status} />
                  <IncidentSeverityPill severity={i.severity} />
                  <span className="font-mono text-[11px] text-faint">
                    {formatIncidentWindow(i.startedAt, i.endedAt, nowMs)}
                  </span>
                  <IncidentOriginMark incident={i} />
                </div>
                <h2 className="mt-1.5 text-[15px] font-semibold text-ink">{i.title}</h2>
                {i.summary !== "" && <p className="mt-1 text-[13px] leading-relaxed text-mid">{i.summary}</p>}
              </Link>
              <div className="flex items-center justify-end border-t border-line px-4 py-2">
                <IncidentCardControls incident={i} />
              </div>
            </section>
          ))}
        </div>
      )}

      {/* A CAPABILITY sentence, not story data: what this list is, and only that. */}
      <p className="mt-3 font-mono text-[10.5px] leading-relaxed text-faint">
        declared by hand, or promoted from this workspace&apos;s own alert events — every incident it holds, newest
        first by its own start; open one for its timeline.
      </p>
    </div>
  );
}
