import { redirect } from "next/navigation";
import { connection } from "next/server";
import { IncidentDetailLive } from "@/components/incidents/IncidentDetailLive";
import { IncidentDetailMock } from "@/components/incidents/IncidentDetailMock";
import { forWorkspace } from "@/server/clickhouse";
import { dataMode, referenceNowMs } from "@/server/data";
import { getExplainQuota } from "@/server/explain/quota";
import { readIncidentTimeline, type StitchedIncidentTimeline } from "@/server/incident-timeline";
import { getIncident } from "@/server/incidents";
import { queryRows } from "@/server/postgres";
import { getSessionContext } from "@/server/session";
import { getUsage } from "@/server/usage";

/**
 * One incident, live-wired (S7.4 T6, D539/D540/D546), in the dashboards
 * detail's D431 shape: the mock branch hands `IncidentDetailMock` the `params`
 * PROMISE, unawaited, before any await on this page — the router awaits it
 * itself and renders the pinned body for the fixture's id or the one D436
 * sentence for any other (D520) — so mock mode pays nothing for a live-only
 * read.
 *
 * THE LIVE BRANCH IS TWO SERIALISED ROUND TRIPS, stated rather than optimised
 * away (D539). The stitcher's arguments are DATA-DEPENDENT: it needs the
 * incident's own window and the plan's retention floor, and the first trip is
 * what produces both. A single `Promise.all` holding the stitcher beside the
 * two reads that produce its arguments is circular and cannot be written; the
 * `services/[id]/page.tsx` shape does not transfer, because both of ITS
 * members key off `params.id` with no dependency between them.
 *
 *   trip 1  `Promise.all([getIncident, getUsage])` — the row and the plan.
 *           `getUsage` is React-cached and the layout has already awaited it,
 *           so the pre-flight costs one statement: the incident read.
 *   miss    an id this workspace does not hold renders the D436 sentence
 *           through `IncidentDetailLive`, and NOTHING ELSE RUNS — no timeline
 *           leg, no ClickHouse scan, no quota row. A bogus id and another
 *           tenant's id issue the same one statement and get the same words
 *           (both halves of D440), so the page cannot be used to learn which
 *           of the two it was.
 *   trip 2  `Promise.all([readIncidentTimeline, getExplainQuota])` — the
 *           three-store stitch (this page is its ONLY caller) and the RCA
 *           rail's counter, independent of each other and so on one trip.
 *
 * The page does all the reading (D441) and `IncidentDetailLive` renders
 * resolved props with no fetching of its own. The workspace comes from the
 * session and from nowhere else (D113): the `forWorkspace` facade scopes the
 * ClickHouse leg, and every Postgres read binds it as `$1`.
 */

/**
 * The one id shape `server/incidents.ts` mints: `inc_` + 16 hex. An id that
 * CANNOT exist answers exactly as one that does not (D440) and costs no
 * statement (D430). Without this screen a NUL byte in the URL segment reaches
 * Postgres as a raw 22021 (measured: `getIncident(ws, a lone U+0000)` throws
 * `invalid byte sequence for encoding "UTF8": 0x00`) — a 500 where an unknown
 * id renders the sentence. It is the class T3 closed on the store's event ids
 * and T5 closed on the RCA route, which carries this same expression.
 * ⟨S7.4 T6 plan correction, D584: D539's "a bogus id issues exactly the
 * `getIncident` statement" is refined — a MALFORMED id issues zero, and a
 * well-formed unknown one issues exactly that one.⟩
 */
const INCIDENT_ID = /^inc_[0-9a-f]{16}$/;

/**
 * What the miss hands the component in place of a stitch that never ran:
 * every leg empty, nothing omitted, nothing clipped, and a zero-width window
 * at this render's one clock. `IncidentDetailLive` returns the D436 sentence
 * before it reads any of this — the prop is required, so the shape is spelled
 * here, where a reader can see it claims nothing. The plan's two fields are
 * the real ones trip 1 already read.
 */
function nothingRead(plan: { retentionDays: number; planName: string }, nowMs: number): StitchedIncidentTimeline {
  const instant = new Date(nowMs).toISOString();
  return {
    entries: [],
    rows: [],
    omissions: [],
    retentionDays: plan.retentionDays,
    planName: plan.planName,
    outsideRetention: false,
    inputClipped: false,
    windowStartIso: instant,
    windowEndIso: instant,
  };
}

/** The RCA rail's counter for a page that renders no rail: no quota row was
 *  read (the miss issues nothing past trip 1), and the pair says so as the
 *  unread zero — never a plan number spelled here (D226). */
const NOTHING_READ_EXPLAIN = { used: 0, quota: 0 };

export default async function IncidentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  if (dataMode !== "live") return <IncidentDetailMock params={params} />;
  await connection();

  const session = await getSessionContext();
  if (!session) redirect("/login");

  const { id } = await params;
  // The render's one clock (D50/D64) — the house's reference clock, which is
  // the request's own `Date.now()` on this branch — sampled ONCE: the header's
  // ongoing duration is measured against it. The stitcher samples its own for
  // the three legs' shared upper bound (D534) — a bound on a READ, not a
  // display value, and it must be one clock across two stores.
  const nowMs = referenceNowMs();

  // ---- trip 1: the row and the plan ----
  const [incident, usage] = await Promise.all([
    INCIDENT_ID.test(id) ? getIncident(session.workspaceId, id, queryRows) : null,
    getUsage(session.workspaceId, queryRows),
  ]);
  if (!incident) {
    return (
      <IncidentDetailLive
        incident={null}
        timeline={nothingRead(usage, nowMs)}
        explain={NOTHING_READ_EXPLAIN}
        nowMs={nowMs}
      />
    );
  }

  // ---- trip 2: the stitch and the counter ----
  const [timeline, explain] = await Promise.all([
    readIncidentTimeline(
      session.workspaceId,
      incident,
      usage.retentionDays,
      usage.planName,
      forWorkspace(session.workspaceId),
      queryRows,
    ),
    getExplainQuota(session.workspaceId, queryRows),
  ]);

  return <IncidentDetailLive incident={incident} timeline={timeline} explain={explain} nowMs={nowMs} />;
}
