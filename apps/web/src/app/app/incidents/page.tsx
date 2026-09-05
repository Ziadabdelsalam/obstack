import { redirect } from "next/navigation";
import { connection } from "next/server";
import { IncidentsLive } from "@/components/incidents/IncidentsLive";
import { IncidentsMock } from "@/components/incidents/IncidentsMock";
import { dataMode, referenceNowMs } from "@/server/data";
import { listIncidents, listPromotableAlertEvents } from "@/server/incidents";
import { queryRows } from "@/server/postgres";
import { getSessionContext } from "@/server/session";

/**
 * Incidents, live-wired (S7.4 T6, D519/D521/D545) in the slos page's D431
 * shape: the mock branch returns master's page body (`IncidentsMock`,
 * byte-pinned by `page.test.ts`) with zero props and before any await, so
 * mock mode pays nothing for a live-only read. D521 names what is different
 * about this flip: the two modes differ in KIND, not only in content — the
 * demo's one fixture is a DETAIL at this URL, while live is the LIST, with
 * each incident's own page under `[id]`. That divergence is ruled and priced,
 * not derived away.
 *
 * The live branch reads the signed-in workspace's own incident rows — every
 * one it holds, no limit and no cursor, because the per-workspace cap is the
 * bound (D529) — and the un-promoted alert events the picker offers, in ONE
 * `Promise.all`, and hands the rows to a server component. The reads are the
 * page's (D441): `IncidentsLive` queries nothing, and
 * `components/incidents/actions.ts` is mutations only.
 *
 * The workspace comes from the session and from nowhere else (D113).
 */

/**
 * How many un-promoted alert events the picker offers, newest first — a
 * MODULE constant and never a client number: the store's limit guard floors
 * and lower-bounds but does not upper-bound, and T3 recorded that `Infinity`
 * reaches Postgres as a raw 22P02. Fifty is the alerts page's own feed depth
 * (`EVENT_FEED_LIMIT`), so the picker offers the same slice of this
 * workspace's events that `/app/alerts` shows.
 */
const PROMOTABLE_LIMIT = 50;

export default async function IncidentsPage() {
  if (dataMode !== "live") return <IncidentsMock />;
  await connection();

  const session = await getSessionContext();
  if (!session) redirect("/login");

  // The render's one clock (D50/D64) — the house's reference clock, which is
  // the request's own `Date.now()` on this branch — sampled ONCE and threaded
  // down, so every ongoing duration on the list is measured against the same
  // instant (the traces pages' rule).
  const nowMs = referenceNowMs();
  const [list, promotable] = await Promise.all([
    listIncidents(session.workspaceId, queryRows),
    listPromotableAlertEvents(session.workspaceId, PROMOTABLE_LIMIT, queryRows),
  ]);

  return (
    <IncidentsLive
      incidents={list.incidents}
      total={list.total}
      ongoing={list.ongoing}
      promotable={promotable}
      nowMs={nowMs}
    />
  );
}
