import "server-only";
import { randomBytes } from "node:crypto";
import {
  MAX_DASHBOARDS,
  MAX_NAME_CHARS,
  MAX_PINNED_WIDGETS,
  MAX_WIDGETS_PER_DASHBOARD,
  METRIC_RANGES,
  WIDGET_KINDS,
  type Dashboard,
  type DashboardWidget,
  type NewDashboardWidget,
  type WidgetKind,
} from "@/lib/dashboard-types";
import { VALID_AGGS, type MetricAgg, type MetricCatalogEntry, type MetricRange } from "@/lib/metrics-types";
import { lockWorkspace, type QueryRows, type TxQuery } from "@/server/postgres";

/**
 * Dashboards: workspace-scoped rows in the product store, on the `saved_views`
 * shape (0002/D424). This is the ONE module that owns dashboard persistence —
 * the in-memory `state/workspace-store.tsx` list it replaces in live mode is
 * fixture state and stays exactly where it is, read by the mock branch alone.
 *
 * A dashboard's widgets are an ORDERED JSONB array (position = index, pin = a
 * flag on the widget, D425) rather than a second table: no reader needs a
 * per-widget row, and one row per dashboard is what makes every widget mutation
 * a single read-modify-write under one lock.
 *
 * Two rules separate this module from `saved-views.ts`, and both are deliberate:
 *
 *  - The name is the identity within a workspace (UNIQUE) but creating under a
 *    taken name is REFUSED, never upserted (D424) — an upsert would silently
 *    replace someone else's widgets, which a saved view (a filter set the caller
 *    just typed) has no equivalent of.
 *  - Every mutation is a read-modify-write over the widget array, so it takes
 *    the workspace advisory lock FIRST and demands a `TxQuery` (D195/D197/D199):
 *    the lock is transaction-scoped and serializes nothing through the plain
 *    pool, so the type demands the transaction the lock needs. Two tabs adding a
 *    twelfth widget are one moment; the loser reads the committed array and is
 *    refused.
 *
 * The workspace is a PARAMETER and never ambient (D113): every statement below
 * names `workspace_id` and binds this argument as `$1`, and the id comes from
 * the session on the server (`components/dashboards/actions.ts`) — never from
 * the client, which only ever names a dashboard it can already see.
 */

/** Every refusal this module raises, as one class the action can catch by identity
 *  rather than by matching prose (the `OverrideLimit` precedent, D429). Its
 *  message is the sentence the surface prints VERBATIM (D430/D436). */
export class DashboardRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DashboardRefusal";
  }
}

/** D436: the same words for an id that never existed and for another tenant's —
 *  the two are indistinguishable from inside a workspace, and must stay so. */
const NO_SUCH_DASHBOARD = "no dashboard with this id in your workspace";
const NO_SUCH_WIDGET = "no widget with this id on this dashboard";

/**
 * Every statement binds the workspace as `$1` and names `workspace_id` in its
 * text — `dashboards.test.ts` asserts both for every call this module makes, so
 * a predicate dropped here goes red instead of leaking a dashboard sideways, and
 * `dashboards.integration.test.ts` proves Postgres agrees.
 *
 * `workspace_id` leads the INSERT's column list so it can lead the bindings.
 */
const LIST_SQL = `
  SELECT id, name, widgets, updated_at
    FROM dashboards
   WHERE workspace_id = $1
   ORDER BY created_at, name`;

const GET_SQL = `
  SELECT id, name, widgets, updated_at
    FROM dashboards
   WHERE workspace_id = $1 AND id = $2`;

const COUNT_SQL = `
  SELECT count(*)::int AS n
    FROM dashboards
   WHERE workspace_id = $1`;

/**
 * The overview's pin budget is a WORKSPACE budget (D425: `/app` renders the
 * workspace's pinned widgets, from every dashboard), so counting it needs every
 * other dashboard's array — the one place a widget mutation reads outside its
 * own row. The dashboard being written is excluded and counted from the array
 * about to be stored, so the count is of the state after the write and a widget
 * already pinned is never counted twice.
 */
const PIN_COUNT_ELSEWHERE_SQL = `
  SELECT count(*)::int AS n
    FROM dashboards d,
         LATERAL jsonb_array_elements(d.widgets) AS w
   WHERE d.workspace_id = $1 AND d.id <> $2 AND (w ->> 'pinned')::boolean IS TRUE`;

const INSERT_SQL = `
  INSERT INTO dashboards (workspace_id, id, name)
       VALUES ($1, $2, $3)`;

const RENAME_SQL = `
  UPDATE dashboards
     SET name = $3, updated_at = now()
   WHERE workspace_id = $1 AND id = $2`;

const SET_WIDGETS_SQL = `
  UPDATE dashboards
     SET widgets = $3::jsonb, updated_at = now()
   WHERE workspace_id = $1 AND id = $2`;

const DELETE_SQL = `
  DELETE FROM dashboards
   WHERE workspace_id = $1 AND id = $2`;

/** D437/D116: app-generated, so a row's id is known before Postgres answers. */
const newDashboardId = (): string => `dash_${randomBytes(8).toString("hex")}`;
const newWidgetId = (): string => `wdg_${randomBytes(8).toString("hex")}`;

/** The row as Postgres returns it: JSONB parsed by the driver, TIMESTAMPTZ a Date. */
type DashboardRow = {
  id: string;
  name: string;
  widgets: DashboardWidget[];
  updated_at: Date;
};

const toDashboard = (row: DashboardRow): Dashboard => ({
  id: row.id,
  name: row.name,
  widgets: row.widgets,
  updatedAt: row.updated_at.toISOString(),
});

/**
 * A dashboard name and a widget title are the same kind of thing — a label the
 * client typed — so D430 gives them one pair of sentences. The cap is read from
 * the contract rather than restated, so the number in the sentence and the
 * number enforced cannot drift.
 */
function checkedName(name: unknown): string {
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (!trimmed) throw new DashboardRefusal("name is required");
  if (trimmed.length > MAX_NAME_CHARS) {
    throw new DashboardRefusal(`name is longer than ${MAX_NAME_CHARS} characters`);
  }
  return trimmed;
}

/**
 * The stored widget, built key by key from an untrusted payload (D430). A server
 * action is reachable by a direct POST and not only through the add-widget form,
 * so every field is checked HERE, before any statement runs, and the object that
 * reaches JSONB is CONSTRUCTED rather than copied: extra keys, a client-supplied
 * `id` and a client-supplied `workspace_id` are dropped by never being read.
 *
 * The vocabulary is the contract's own — `WIDGET_KINDS`, `METRIC_RANGES` and
 * `VALID_AGGS` (D390's one agg-validity table) — so the store refuses exactly
 * what `server/queries/metrics.ts` would refuse, and a widget that saved cannot
 * fail to query for a reason the form could have caught.
 *
 * Metric EXISTENCE is deliberately not checked: a metric the workspace stopped
 * emitting is an honest empty card (D436), not a widget that cannot be saved.
 */
function storedWidget(widget: NewDashboardWidget): DashboardWidget {
  const w: Partial<NewDashboardWidget> =
    typeof widget === "object" && widget !== null && !Array.isArray(widget) ? widget : {};

  const title = checkedName(w.title);

  const kind = w.kind as WidgetKind;
  if (!WIDGET_KINDS.includes(kind)) {
    throw new DashboardRefusal(`unknown widget kind ${JSON.stringify(w.kind ?? null)}`);
  }

  const type = w.type as MetricCatalogEntry["type"];
  const aggs: readonly MetricAgg[] | undefined = VALID_AGGS[type];
  if (!aggs) throw new DashboardRefusal(`unknown metric type ${JSON.stringify(w.type ?? null)}`);

  const agg = w.agg as MetricAgg;
  if (!aggs.includes(agg)) {
    throw new DashboardRefusal(`${JSON.stringify(w.agg ?? null)} is not an aggregation a ${type} answers`);
  }

  const range = w.range as MetricRange;
  if (!METRIC_RANGES.includes(range)) {
    throw new DashboardRefusal(`unknown range ${JSON.stringify(w.range ?? null)}`);
  }

  const metric = typeof w.metric === "string" ? w.metric.trim() : "";
  if (!metric) throw new DashboardRefusal("metric is required");

  const grouped = typeof w.groupBy === "string" ? w.groupBy.trim() : "";
  if (w.groupBy !== null && !grouped) {
    throw new DashboardRefusal("group-by is an attribute key or nothing at all");
  }
  const groupBy = w.groupBy === null ? null : grouped;

  // The two kinds that ARE a grouping, and the one that is a single number.
  if (kind === "stat" && groupBy !== null) throw new DashboardRefusal("a stat has no group-by");
  if ((kind === "topn" || kind === "table") && groupBy === null) {
    throw new DashboardRefusal("top-n and table need a group-by");
  }

  if (typeof w.pinned !== "boolean") throw new DashboardRefusal("pinned is true or false");

  return { id: newWidgetId(), title, kind, metric, type, agg, range, groupBy, pinned: w.pinned };
}

/**
 * The UNIQUE key's violation, translated at the one place it can arise. Postgres
 * is the arbiter rather than a SELECT this module could run first, because two
 * tabs creating the same name would both pass that SELECT — and D424 refuses the
 * second rather than upserting over the first's widgets.
 */
async function refusingDuplicateName<T>(name: string, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if ((error as { code?: string })?.code === "23505") {
      throw new DashboardRefusal(`a dashboard named “${name}” already exists`);
    }
    throw error;
  }
}

/** This workspace's dashboards, oldest first — the name breaks the tie so two
 *  created in one transaction cannot swap places between reads. */
export async function listDashboards(workspaceId: string, query: QueryRows): Promise<Dashboard[]> {
  const rows = await query<DashboardRow>(LIST_SQL, [workspaceId]);
  return rows.map(toDashboard);
}

/** One dashboard, or `null` — an id from another workspace answers exactly as an
 *  invented one does, which is the tenancy boundary read from the outside. */
export async function getDashboard(
  workspaceId: string,
  id: string,
  query: QueryRows,
): Promise<Dashboard | null> {
  const [row] = await query<DashboardRow>(GET_SQL, [workspaceId, id]);
  return row ? toDashboard(row) : null;
}

/** The same read a mutation makes, refusing instead of answering `null`: every
 *  widget mutation needs the current array, and the id it was handed is client
 *  input. */
async function readRow(workspaceId: string, id: string, query: QueryRows): Promise<DashboardRow> {
  const [row] = await query<DashboardRow>(GET_SQL, [workspaceId, id]);
  if (!row) throw new DashboardRefusal(NO_SUCH_DASHBOARD);
  return row;
}

/** The fresh row as the store holds it, read back AFTER the write (D429) rather
 *  than assembled from what the caller asked for — a surface can never show a
 *  widget the database did not take. */
async function readBack(workspaceId: string, id: string, query: QueryRows): Promise<Dashboard> {
  return toDashboard(await readRow(workspaceId, id, query));
}

/**
 * The overview cap, weighed on the array about to be stored (D425/D402). Called
 * only by the two mutations that can ADD a pin: nothing else can push the
 * workspace over, and a statement that cannot change the answer is a statement
 * this module does not run.
 */
async function refusePinOverflow(
  workspaceId: string,
  id: string,
  next: DashboardWidget[],
  query: QueryRows,
): Promise<void> {
  const here = next.filter((w) => w.pinned).length;
  const [{ n }] = await query<{ n: number }>(PIN_COUNT_ELSEWHERE_SQL, [workspaceId, id]);
  if (here + n > MAX_PINNED_WIDGETS) {
    throw new DashboardRefusal(`overview is full (${MAX_PINNED_WIDGETS} pinned)`);
  }
}

/**
 * Create an empty dashboard. The workspace cap is a read-modify-write and so is
 * counted under the lock; the NAME collision is Postgres's UNIQUE key, refused
 * rather than upserted (D424).
 */
export async function createDashboard(
  workspaceId: string,
  name: string,
  query: TxQuery,
): Promise<Dashboard> {
  const trimmed = checkedName(name);
  await lockWorkspace(query, workspaceId);

  const [{ n }] = await query<{ n: number }>(COUNT_SQL, [workspaceId]);
  if (n >= MAX_DASHBOARDS) {
    throw new DashboardRefusal(`workspace limit reached (${MAX_DASHBOARDS} dashboards)`);
  }

  const id = newDashboardId();
  await refusingDuplicateName(trimmed, () => query(INSERT_SQL, [workspaceId, id, trimmed]));
  return readBack(workspaceId, id, query);
}

/** Rename in place. The read first so an unknown id is the D436 sentence rather
 *  than an UPDATE that quietly matched nothing. */
export async function renameDashboard(
  workspaceId: string,
  id: string,
  name: string,
  query: TxQuery,
): Promise<Dashboard> {
  const trimmed = checkedName(name);
  await lockWorkspace(query, workspaceId);
  await readRow(workspaceId, id, query);

  await refusingDuplicateName(trimmed, () => query(RENAME_SQL, [workspaceId, id, trimmed]));
  return readBack(workspaceId, id, query);
}

/**
 * Drop a dashboard and answer with the workspace's remaining list (the
 * `deleteSavedView` shape). An id this workspace does not hold matches no row
 * and gets the same list a stale tab would get: there is nothing to refuse, and
 * nothing a foreign id could learn.
 */
export async function deleteDashboard(
  workspaceId: string,
  id: string,
  query: TxQuery,
): Promise<Dashboard[]> {
  await lockWorkspace(query, workspaceId);
  await query(DELETE_SQL, [workspaceId, id]);
  return listDashboards(workspaceId, query);
}

/** Append a widget. Shape is judged before the lock (D430: a refused payload runs
 *  zero statements); the two caps need the stored state and are judged after it. */
export async function addWidget(
  workspaceId: string,
  id: string,
  widget: NewDashboardWidget,
  query: TxQuery,
): Promise<Dashboard> {
  const stored = storedWidget(widget);
  await lockWorkspace(query, workspaceId);
  const row = await readRow(workspaceId, id, query);

  if (row.widgets.length >= MAX_WIDGETS_PER_DASHBOARD) {
    throw new DashboardRefusal(`this dashboard is full (${MAX_WIDGETS_PER_DASHBOARD} widgets)`);
  }
  const next = [...row.widgets, stored];
  if (stored.pinned) await refusePinOverflow(workspaceId, id, next, query);

  await query(SET_WIDGETS_SQL, [workspaceId, id, JSON.stringify(next)]);
  return readBack(workspaceId, id, query);
}

/** Remove one widget by id; the rest keep their order. */
export async function removeWidget(
  workspaceId: string,
  id: string,
  widgetId: string,
  query: TxQuery,
): Promise<Dashboard> {
  await lockWorkspace(query, workspaceId);
  const row = await readRow(workspaceId, id, query);

  const next = row.widgets.filter((w) => w.id !== widgetId);
  if (next.length === row.widgets.length) throw new DashboardRefusal(NO_SUCH_WIDGET);

  await query(SET_WIDGETS_SQL, [workspaceId, id, JSON.stringify(next)]);
  return readBack(workspaceId, id, query);
}

/**
 * Swap a widget with its neighbour — position IS the index, so a move is a
 * reorder of the stored array and nothing else. A move past either end writes
 * NOTHING and answers with the row already read: the surface's buttons stay
 * live at the ends, and pressing one costs no version of the row.
 */
export async function moveWidget(
  workspaceId: string,
  id: string,
  widgetId: string,
  direction: "up" | "down",
  query: TxQuery,
): Promise<Dashboard> {
  if (direction !== "up" && direction !== "down") {
    throw new DashboardRefusal(`unknown direction ${JSON.stringify(direction)}`);
  }
  await lockWorkspace(query, workspaceId);
  const row = await readRow(workspaceId, id, query);

  const at = row.widgets.findIndex((w) => w.id === widgetId);
  if (at < 0) throw new DashboardRefusal(NO_SUCH_WIDGET);

  const to = direction === "up" ? at - 1 : at + 1;
  if (to < 0 || to >= row.widgets.length) return toDashboard(row);

  const next = [...row.widgets];
  [next[at], next[to]] = [next[to], next[at]];

  await query(SET_WIDGETS_SQL, [workspaceId, id, JSON.stringify(next)]);
  return readBack(workspaceId, id, query);
}

/** Pin or unpin one widget — the overview is a view over this flag (D425), never
 *  a dashboard of its own. */
export async function setWidgetPinned(
  workspaceId: string,
  id: string,
  widgetId: string,
  pinned: boolean,
  query: TxQuery,
): Promise<Dashboard> {
  if (typeof pinned !== "boolean") throw new DashboardRefusal("pinned is true or false");
  await lockWorkspace(query, workspaceId);
  const row = await readRow(workspaceId, id, query);

  const at = row.widgets.findIndex((w) => w.id === widgetId);
  if (at < 0) throw new DashboardRefusal(NO_SUCH_WIDGET);

  const next = row.widgets.map((w, i) => (i === at ? { ...w, pinned } : w));
  if (pinned) await refusePinOverflow(workspaceId, id, next, query);

  await query(SET_WIDGETS_SQL, [workspaceId, id, JSON.stringify(next)]);
  return readBack(workspaceId, id, query);
}
