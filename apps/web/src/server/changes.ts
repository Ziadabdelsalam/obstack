import "server-only";
import type { ChangeEventRow, ChangeKind, ChangeLink, ServiceDeployRow } from "@/lib/change-types";
import type { QueryRows } from "@/server/postgres";

/**
 * Changes: the timeline and the services deploys panel, on the
 * `change_events` shape (`services/ingest/pgmigrations/0011_change_events.sql`,
 * packet D500). READS ONLY, by design (packet §0): the one writer is the
 * ingest endpoint `POST /v1/changes` under api-key auth, and v1 has no manual
 * entry — so there is no mutation here, no `components/changes/actions.ts`,
 * and nothing for an expose-only guard to guard. The retention sweeper
 * (`services/ingest/internal/retention`, D501) is the one deleter.
 *
 * The workspace is a PARAMETER and never ambient (D113), the `alerts.ts` /
 * `dashboards.ts` rule: every statement names `workspace_id` and binds this
 * argument as `$1`, and the id comes from the session on the server — never
 * from the client.
 *
 * Ordering is by `at` — the event's OWN time — and never `created_at`: a
 * backfilled deploy sorts where it happened, not when it arrived (D499/D500).
 * `id DESC` breaks ties so two events at one instant render in a stable order.
 */

type EventRow = {
  id: string;
  kind: ChangeKind;
  at: Date;
  title: string;
  detail: string;
  who: string;
  service: string | null;
  ref: string | null;
  source: string | null;
  link_label: string | null;
  link_href: string | null;
};

/** The two link columns are set together or not at all (the 0011 CHECK); the
 *  row folds them to one object or null. */
const toLink = (label: string | null, href: string | null): ChangeLink | null =>
  label !== null && href !== null ? { label, href } : null;

const toEvent = (row: EventRow): ChangeEventRow => ({
  id: row.id,
  kind: row.kind,
  at: row.at.toISOString(),
  title: row.title,
  detail: row.detail,
  who: row.who,
  service: row.service,
  ref: row.ref,
  source: row.source,
  link: toLink(row.link_label, row.link_href),
});

const toDeploy = (row: EventRow): ServiceDeployRow => ({
  id: row.id,
  ref: row.ref,
  at: row.at.toISOString(),
  who: row.who,
  title: row.title,
  link: toLink(row.link_label, row.link_href),
});

// ---- statements: workspace_id leads every one, $1-bound ---------------------

const COLUMNS = "id, kind, at, title, detail, who, service, ref, source, link_label, link_href";

const LIST_EVENTS_SQL = `
  SELECT ${COLUMNS}
    FROM change_events
   WHERE workspace_id = $1
   ORDER BY at DESC, id DESC
   LIMIT $2`;

/** The deploys panel's read, on the partial index the DDL keeps for it. */
const LIST_SERVICE_DEPLOYS_SQL = `
  SELECT ${COLUMNS}
    FROM change_events
   WHERE workspace_id = $1 AND kind = 'deploy' AND service = $2
   ORDER BY at DESC, id DESC
   LIMIT $3`;

/** A limit is a positive integer or it is 1. */
const clampLimit = (limit: number): number => Math.max(1, Math.floor(limit) || 1);

// ---- reads ---------------------------------------------------------------------

/** The workspace's timeline, newest-first by the event's own time. */
export async function listChangeEvents(
  workspaceId: string,
  limit: number,
  query: QueryRows,
): Promise<ChangeEventRow[]> {
  const rows = await query<EventRow>(LIST_EVENTS_SQL, [workspaceId, clampLimit(limit)]);
  return rows.map(toEvent);
}

/** One service's `deploy` events, newest-first — the services deploys panel
 *  (D503). `service` is matched by EQUALITY with the trace-derived service name
 *  (`spans.service` is the identity, D367); a deploy recorded before the
 *  service's first span is simply not yet on any service page. */
export async function listServiceDeploys(
  workspaceId: string,
  service: string,
  limit: number,
  query: QueryRows,
): Promise<ServiceDeployRow[]> {
  const rows = await query<EventRow>(LIST_SERVICE_DEPLOYS_SQL, [workspaceId, service, clampLimit(limit)]);
  return rows.map(toDeploy);
}
