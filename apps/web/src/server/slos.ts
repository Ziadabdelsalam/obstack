import "server-only";
import { randomBytes } from "node:crypto";
import {
  SLO_WINDOWS,
  validateSloIndicator,
  type SloIndicator,
  type SloRow,
  type SloStatus,
  type SloWindow,
} from "@/lib/slo-types";
import { NO_SUCH_CHANNEL } from "@/server/alerts";
import { lockWorkspace, type QueryRows, type TxQuery } from "@/server/postgres";

/**
 * SLOs: definitions CRUD on the `slos` shape
 * (`services/ingest/pgmigrations/0012_slos.sql`, packet D513). This is the ONE
 * module that owns SLO persistence on the web side — the evaluator
 * (`services/ingest/internal/alerting`, D510) claims rows on its own tick and
 * writes the MEASUREMENT columns (status, current_pct, budget_burned_pct,
 * good_count, total_count, evaluated_at, last_transition_at, next_eval_at);
 * this module reads them and never writes them, except to RESET them when the
 * objective itself changes (see `updateSlo`).
 *
 * The workspace is a PARAMETER and never ambient (D113), the `alerts.ts` rule:
 * every statement names `workspace_id` and binds this argument as `$1`, and
 * the id comes from the session on the server (`components/slos/actions.ts`)
 * — never from the client.
 *
 * Every mutation takes the workspace advisory lock FIRST (D195/D197/D199): a
 * `TxQuery` is demanded so the lock actually serializes the read→write.
 *
 * An id from another workspace answers exactly as an invented one does (D440):
 * "refused" and "absent" are indistinguishable from inside a workspace.
 */

/** Every refusal this module raises, as one class the action catches by
 *  identity (the `AlertRefusal` precedent). Its message is the sentence the
 *  surface prints VERBATIM. */
export class SloRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SloRefusal";
  }
}

/** D440: the same words for an id that never existed and for another tenant's. */
const NO_SUCH_SLO = "no SLO with this id in your workspace";

/** App-generated ids, the `rule_`/`chan_` idiom (D437/D116). */
const newSloId = (): string => `slo_${randomBytes(8).toString("hex")}`;

/** D513: the cap that bounds D510's cost (≤ 50 merges of ≤ 30 days per
 *  workspace per 5 minutes). Counted under the same lock the INSERT runs under. */
export const MAX_SLOS_PER_WORKSPACE = 50;

// ---- row shapes as Postgres returns them -------------------------------------

/** `pg` hands back NUMERIC and BIGINT as STRINGS; they are converted at the
 *  one place the row is mapped, never at a call site. */
type Row = {
  id: string;
  name: string;
  indicator: SloIndicator;
  target: string;
  eval_window: SloWindow;
  channel_id: string | null;
  channel_name: string | null;
  enabled: boolean;
  status: SloStatus;
  current_pct: number | null;
  budget_burned_pct: number | null;
  good_count: string | null;
  total_count: string | null;
  evaluated_at: Date | null;
  last_transition_at: Date | null;
};

const count = (raw: string | null): number | null => (raw === null ? null : Number(raw));
const iso = (at: Date | null): string | null => (at ? at.toISOString() : null);

const toRow = (row: Row): SloRow => ({
  id: row.id,
  name: row.name,
  indicator: row.indicator,
  target: Number(row.target),
  window: row.eval_window,
  channelId: row.channel_id,
  channelName: row.channel_name,
  enabled: row.enabled,
  status: row.status,
  currentPct: row.current_pct,
  budgetBurnedPct: row.budget_burned_pct,
  goodCount: count(row.good_count),
  totalCount: count(row.total_count),
  evaluatedAt: iso(row.evaluated_at),
  lastTransitionAt: iso(row.last_transition_at),
});

// ---- statements: workspace_id leads every one, $1-bound ---------------------

const COLUMNS = `s.id, s.name, s.indicator, s.target::text AS target, s.eval_window,
         s.channel_id, c.name AS channel_name, s.enabled, s.status,
         s.current_pct, s.budget_burned_pct, s.good_count::text AS good_count, s.total_count::text AS total_count,
         s.evaluated_at, s.last_transition_at`;

const LIST_SLOS_SQL = `
  SELECT ${COLUMNS}
    FROM slos s
    LEFT JOIN notification_channels c ON c.id = s.channel_id
   WHERE s.workspace_id = $1
   ORDER BY s.created_at, s.name`;

const GET_SLO_SQL = `
  SELECT ${COLUMNS}
    FROM slos s
    LEFT JOIN notification_channels c ON c.id = s.channel_id
   WHERE s.workspace_id = $1 AND s.id = $2`;

const INSERT_SLO_SQL = `
  INSERT INTO slos (workspace_id, id, name, indicator, target, eval_window, channel_id)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)`;

/** The editable content only. Never `enabled` (the toggle's), never a
 *  measurement column or `next_eval_at` (the evaluator's). */
const UPDATE_SLO_SQL = `
  UPDATE slos
     SET name = $3, indicator = $4::jsonb, target = $5, eval_window = $6, channel_id = $7, updated_at = now()
   WHERE workspace_id = $1 AND id = $2`;

/** D518 (in-flight, recorded): when the OBJECTIVE changes — indicator, target
 *  or window — the numbers on the row were measured against a different
 *  objective and rendering them under the new one would be a D13 lie for up
 *  to a cadence. They go back to the honest never-measured state and the
 *  evaluator is asked for a fresh read now. A rename or a channel change
 *  leaves the measurement alone. */
const RESET_MEASUREMENT_SQL = `
  UPDATE slos
     SET status = 'no-data', current_pct = NULL, budget_burned_pct = NULL,
         good_count = NULL, total_count = NULL, evaluated_at = NULL, last_transition_at = NULL,
         next_eval_at = now()
   WHERE workspace_id = $1 AND id = $2`;

const SET_SLO_ENABLED_SQL = `
  UPDATE slos
     SET enabled = $3, updated_at = now()
   WHERE workspace_id = $1 AND id = $2`;

const DELETE_SLO_SQL = `
  DELETE FROM slos
   WHERE workspace_id = $1 AND id = $2`;

const COUNT_SLOS_SQL = `
  SELECT count(*)::int AS n
    FROM slos
   WHERE workspace_id = $1`;

/** The channel must EXIST in this workspace — no `target` in the projection
 *  (the `alerts.ts` statement, verbatim, so it can never be the leak). */
const CHANNEL_EXISTS_SQL = `
  SELECT id
    FROM notification_channels
   WHERE workspace_id = $1 AND id = $2`;

// ---- validation (D430: judged before the lock, costs no statement) ---------

/** The UNIQUE key's violation, translated at the one place it can arise
 *  (refused, never upserted — D424). */
async function refusingDuplicateName<T>(name: string, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if ((error as { code?: string })?.code === "23505") {
      throw new SloRefusal(`the name “${name}” is already in use`);
    }
    throw error;
  }
}

function checkedName(name: unknown): string {
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (!trimmed) throw new SloRefusal("name is required");
  return trimmed;
}

function checkedIndicator(indicator: unknown): SloIndicator {
  const result = validateSloIndicator(indicator);
  if (!result.ok) throw new SloRefusal(result.error);
  return result.indicator;
}

/** Strictly inside (0, 100) with at most three decimals — the NUMERIC(6,3)
 *  the DDL holds, judged here so the CHECK never surfaces as a 500. */
function checkedTarget(target: unknown): number {
  if (
    typeof target !== "number" ||
    !Number.isFinite(target) ||
    target <= 0 ||
    target >= 100 ||
    Math.round(target * 1000) / 1000 !== target
  ) {
    throw new SloRefusal("target must be a percentage between 0 and 100, exclusive, with at most three decimals");
  }
  return target;
}

function checkedWindow(window: unknown): SloWindow {
  if (!SLO_WINDOWS.includes(window as SloWindow)) {
    throw new SloRefusal(`window must be one of ${SLO_WINDOWS.join(", ")}`);
  }
  return window as SloWindow;
}

/** `null` is "no channel" (D511); a string must be an id. A blank string is
 *  neither — the form sends null for none, so a blank is a bug, refused. */
function checkedChannelId(channelId: unknown): string | null {
  if (channelId === null || channelId === undefined) return null;
  if (typeof channelId !== "string" || channelId.trim() === "") {
    throw new SloRefusal("channel must be a channel id or null");
  }
  return channelId.trim();
}

/** The full editable shape — everything `createSlo` and `updateSlo` accept.
 *  `enabled` is deliberately NOT here: it is `setSloEnabled`'s alone. */
export interface SloInput {
  name: string;
  indicator: unknown;
  target: number;
  window: SloWindow;
  channelId: string | null;
}

type CheckedInput = {
  name: string;
  indicator: SloIndicator;
  target: number;
  window: SloWindow;
  channelId: string | null;
};

/** Shape checks only — no statement runs from here (D430). Channel EXISTENCE
 *  is a database question and is checked by the caller, after the lock. */
function checkedInput(input: SloInput): CheckedInput {
  return {
    name: checkedName(input.name),
    indicator: checkedIndicator(input.indicator),
    target: checkedTarget(input.target),
    window: checkedWindow(input.window),
    channelId: checkedChannelId(input.channelId),
  };
}

async function assertChannelExists(workspaceId: string, channelId: string, query: QueryRows): Promise<void> {
  const [row] = await query<{ id: string }>(CHANNEL_EXISTS_SQL, [workspaceId, channelId]);
  if (!row) throw new SloRefusal(NO_SUCH_CHANNEL);
}

async function readRow(workspaceId: string, id: string, query: QueryRows): Promise<Row> {
  const [row] = await query<Row>(GET_SLO_SQL, [workspaceId, id]);
  if (!row) throw new SloRefusal(NO_SUCH_SLO);
  return row;
}

async function readBack(workspaceId: string, id: string, query: QueryRows): Promise<SloRow> {
  return toRow(await readRow(workspaceId, id, query));
}

// ---- reads (packet §0) ------------------------------------------------------------

/** This workspace's SLOs, oldest first — the name breaks the tie (the
 *  `listAlertRules` order). The channel name rides along for the card. */
export async function listSlos(workspaceId: string, query: QueryRows): Promise<SloRow[]> {
  const rows = await query<Row>(LIST_SLOS_SQL, [workspaceId]);
  return rows.map(toRow);
}

// ---- mutations ----------------------------------------------------------------------

/** Create an SLO. Shape is judged before the lock; the channel's EXISTENCE
 *  (when one is named) and the name's UNIQUEness are judged after it. A new
 *  row starts in the honest `no-data` state with `next_eval_at = now()` (the
 *  DDL's defaults) — the evaluator's next tick measures it. */
export async function createSlo(workspaceId: string, input: SloInput, query: TxQuery): Promise<SloRow> {
  const checked = checkedInput(input);
  await lockWorkspace(query, workspaceId);

  const [{ n }] = await query<{ n: number }>(COUNT_SLOS_SQL, [workspaceId]);
  if (n >= MAX_SLOS_PER_WORKSPACE) {
    throw new SloRefusal(`this workspace already has ${MAX_SLOS_PER_WORKSPACE} SLOs — the maximum`);
  }
  if (checked.channelId !== null) await assertChannelExists(workspaceId, checked.channelId, query);

  const id = newSloId();
  await refusingDuplicateName(checked.name, () =>
    query(INSERT_SLO_SQL, [
      workspaceId,
      id,
      checked.name,
      JSON.stringify(checked.indicator),
      checked.target,
      checked.window,
      checked.channelId,
    ]),
  );
  return readBack(workspaceId, id, query);
}

/** Objective and target are compared structurally, key order aside. */
const objectiveChanged = (before: Row, after: CheckedInput): boolean =>
  Number(before.target) !== after.target ||
  before.eval_window !== after.window ||
  JSON.stringify(validateSloIndicator(before.indicator)) !== JSON.stringify(validateSloIndicator(after.indicator));

/** Update an SLO's editable content. Never touches `enabled`; touches the
 *  measurement columns ONLY to reset them when the objective changed (D518,
 *  in-flight). The workspace cannot be changed: it is not part of `SloInput`
 *  and the WHERE clause is the only place it appears. */
export async function updateSlo(workspaceId: string, id: string, input: SloInput, query: TxQuery): Promise<SloRow> {
  const checked = checkedInput(input);
  await lockWorkspace(query, workspaceId);
  const before = await readRow(workspaceId, id, query);
  if (checked.channelId !== null) await assertChannelExists(workspaceId, checked.channelId, query);

  await refusingDuplicateName(checked.name, () =>
    query(UPDATE_SLO_SQL, [
      workspaceId,
      id,
      checked.name,
      JSON.stringify(checked.indicator),
      checked.target,
      checked.window,
      checked.channelId,
    ]),
  );
  if (objectiveChanged(before, checked)) await query(RESET_MEASUREMENT_SQL, [workspaceId, id]);
  return readBack(workspaceId, id, query);
}

/** Enable or disable an SLO — the toggle, independent of the edit form. A
 *  disabled SLO keeps its last measurement (it is still what was measured)
 *  and is simply not claimed. */
export async function setSloEnabled(workspaceId: string, id: string, enabled: boolean, query: TxQuery): Promise<SloRow> {
  if (typeof enabled !== "boolean") throw new SloRefusal("enabled is true or false");
  await lockWorkspace(query, workspaceId);
  await readRow(workspaceId, id, query);

  await query(SET_SLO_ENABLED_SQL, [workspaceId, id, enabled]);
  return readBack(workspaceId, id, query);
}

/** Drop an SLO and answer with the workspace's remaining list (the
 *  `deleteAlertRule` shape): an id this workspace does not hold matches no
 *  row and gets the same list a stale tab would get. Its events CASCADE
 *  (0012's own FK). */
export async function deleteSlo(workspaceId: string, id: string, query: TxQuery): Promise<SloRow[]> {
  await lockWorkspace(query, workspaceId);
  await query(DELETE_SLO_SQL, [workspaceId, id]);
  return listSlos(workspaceId, query);
}
