import "server-only";
import { randomBytes } from "node:crypto";
import {
  validateAlertCondition,
  type AlertCondition,
  type AlertDelivery,
  type AlertEventRow,
  type AlertRuleRow,
  type AlertSeverity,
  type NotificationChannelKind,
  type NotificationChannelRow,
} from "@/lib/alert-types";
import { lockWorkspace, type QueryRows, type TxQuery } from "@/server/postgres";

/**
 * Alerts: rules, notification channels and the events feed, on the
 * `alert_rules`/`notification_channels`/`alert_events` shape
 * (`services/ingest/pgmigrations/0010_alerts.sql`, packet §4). This is the ONE
 * module that owns alert persistence on the web side — the evaluator
 * (`services/ingest/internal/alerting`) claims and transitions rules on its own
 * ticker and never goes through here; this module is read-and-mutate only, the
 * same split `dashboards.ts` keeps with `metering.go`.
 *
 * The workspace is a PARAMETER and never ambient (D113), exactly the
 * `dashboards.ts` rule: every statement below names `workspace_id` and binds
 * this argument as `$1`, and the id comes from the session on the server
 * (`components/alerts/actions.ts`) — never from the client.
 *
 * Every mutation takes the workspace advisory lock FIRST (D195/D197/D199,
 * copied from `dashboards.ts`): a `TxQuery` is demanded so the lock — which is
 * transaction-scoped — actually serializes the read→write it wraps. Through
 * the plain pool it would release inside its own implicit transaction and
 * serialize nothing.
 *
 * An id from another workspace answers exactly as an invented one does — the
 * D440 shape `dashboards.ts` keeps for `NO_SUCH_DASHBOARD`: "refused" and
 * "absent" are indistinguishable from inside a workspace, so neither this
 * module's sentences nor its control flow may let a caller tell the two apart.
 */

/** Every refusal this module raises, as one class the action can catch by
 *  identity (the `DashboardRefusal` precedent, D429). Its message is the
 *  sentence the surface prints VERBATIM. */
export class AlertRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AlertRefusal";
  }
}

/** D440: the same words for an id that never existed and for another tenant's.
 *  `NO_SUCH_CHANNEL` is exported for `server/slos.ts`, which checks the same
 *  reference and must refuse in the same words. */
const NO_SUCH_RULE = "no alert rule with this id in your workspace";
export const NO_SUCH_CHANNEL = "no notification channel with this id in your workspace";

const SEVERITIES: readonly AlertSeverity[] = ["critical", "warning", "info"];
const CHANNEL_KINDS: readonly NotificationChannelKind[] = ["webhook", "slack_webhook"];

/** App-generated ids, the `dash_`/`wdg_` idiom (D437/D116). */
const newRuleId = (): string => `rule_${randomBytes(8).toString("hex")}`;
const newChannelId = (): string => `chan_${randomBytes(8).toString("hex")}`;
const newEventId = (): string => `evt_${randomBytes(8).toString("hex")}`;

// ---- masking (D487) ----------------------------------------------------------

/**
 * A channel `target` is a secret by default (a Slack webhook URL IS its own
 * credential, D487): this is the ONE place a target is reduced to something
 * safe to render, and it is what every read path in this module calls instead
 * of ever selecting the column bare.
 *
 * `services/ingest/internal/notify/policy.go`'s `MaskTarget` is the Go twin,
 * and this is a byte-for-byte port of its rule — the drive's hygiene sweep
 * (S6.1 T8 pattern) cross-checks that both sides render the identical string
 * for the identical target:
 *
 *   scheme + "://" + host (with port) + "/..." + the last 4 characters of the path
 *
 * Query string and userinfo are DROPPED ENTIRELY — both routinely carry the
 * token. The three dots are ASCII (`...`), never a unicode ellipsis: the
 * hygiene sweep diffs the two languages' output byte for byte. A target that
 * does not parse as an absolute URL (no scheme, no host) renders as the
 * literal string `(invalid target)` rather than being echoed.
 */
export function maskTarget(target: string): string {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return "(invalid target)";
  }
  if (!url.host) return "(invalid target)";
  const scheme = url.protocol.replace(/:$/, "");
  const path = url.pathname.replace(/^\//, "");
  const tail = path.length > 4 ? path.slice(-4) : path;
  return `${scheme}://${url.host}/...${tail}`;
}

// ---- row shapes as Postgres returns them -------------------------------------

type RuleRow = {
  id: string;
  name: string;
  condition: AlertCondition;
  severity: AlertSeverity;
  channel_id: string;
  channel_name: string;
  enabled: boolean;
  runbook: string | null;
  state: "ok" | "firing";
  last_triggered_at: Date | null;
};

const toRule = (row: RuleRow): AlertRuleRow => ({
  id: row.id,
  name: row.name,
  condition: row.condition,
  severity: row.severity,
  channelId: row.channel_id,
  channelName: row.channel_name,
  enabled: row.enabled,
  runbook: row.runbook,
  state: row.state,
  lastTriggeredAt: row.last_triggered_at ? row.last_triggered_at.toISOString() : null,
});

type ChannelRow = {
  id: string;
  name: string;
  kind: NotificationChannelKind;
  target: string;
  enabled: boolean;
};

const toChannel = (row: ChannelRow): NotificationChannelRow => ({
  id: row.id,
  name: row.name,
  kind: row.kind,
  targetMasked: maskTarget(row.target),
  enabled: row.enabled,
});

type EventRow = {
  id: string;
  rule_id: string | null;
  rule_name: string | null;
  slo_id: string | null;
  slo_name: string | null;
  severity: AlertSeverity;
  title: string;
  detail: string;
  link: string | null;
  delivery: AlertDelivery;
  created_at: Date;
};

const toEvent = (row: EventRow): AlertEventRow => ({
  id: row.id,
  ruleId: row.rule_id,
  ruleName: row.rule_name,
  sloId: row.slo_id,
  sloName: row.slo_name,
  severity: row.severity,
  title: row.title,
  detail: row.detail,
  link: row.link,
  delivery: row.delivery,
  at: row.created_at.toISOString(),
});

// ---- statements: workspace_id leads every one, $1-bound ---------------------

const LIST_RULES_SQL = `
  SELECT r.id, r.name, r.condition, r.severity, r.channel_id, c.name AS channel_name,
         r.enabled, r.runbook, r.state, r.last_triggered_at
    FROM alert_rules r
    JOIN notification_channels c ON c.id = r.channel_id
   WHERE r.workspace_id = $1
   ORDER BY r.created_at, r.name`;

const GET_RULE_SQL = `
  SELECT r.id, r.name, r.condition, r.severity, r.channel_id, c.name AS channel_name,
         r.enabled, r.runbook, r.state, r.last_triggered_at
    FROM alert_rules r
    JOIN notification_channels c ON c.id = r.channel_id
   WHERE r.workspace_id = $1 AND r.id = $2`;

const INSERT_RULE_SQL = `
  INSERT INTO alert_rules (workspace_id, id, name, condition, severity, channel_id, runbook)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)`;

const UPDATE_RULE_SQL = `
  UPDATE alert_rules
     SET name = $3, condition = $4::jsonb, severity = $5, channel_id = $6, runbook = $7, updated_at = now()
   WHERE workspace_id = $1 AND id = $2`;

const SET_RULE_ENABLED_SQL = `
  UPDATE alert_rules
     SET enabled = $3, updated_at = now()
   WHERE workspace_id = $1 AND id = $2`;

const DELETE_RULE_SQL = `
  DELETE FROM alert_rules
   WHERE workspace_id = $1 AND id = $2`;

const LIST_CHANNELS_SQL = `
  SELECT id, name, kind, target, enabled
    FROM notification_channels
   WHERE workspace_id = $1
   ORDER BY created_at, name`;

const GET_CHANNEL_SQL = `
  SELECT id, name, kind, target, enabled
    FROM notification_channels
   WHERE workspace_id = $1 AND id = $2`;

/** `createAlertRule`/`updateAlertRule`'s own check: the channel must EXIST,
 *  enabled or not — no `target` in the projection, so this statement alone
 *  can never be the leak even if a caller misused it. */
const CHANNEL_EXISTS_SQL = `
  SELECT id
    FROM notification_channels
   WHERE workspace_id = $1 AND id = $2`;

const INSERT_CHANNEL_SQL = `
  INSERT INTO notification_channels (workspace_id, id, name, kind, target)
       VALUES ($1, $2, $3, $4, $5)`;

const SET_CHANNEL_ENABLED_SQL = `
  UPDATE notification_channels
     SET enabled = $3, updated_at = now()
   WHERE workspace_id = $1 AND id = $2`;

const DELETE_CHANNEL_SQL = `
  DELETE FROM notification_channels
   WHERE workspace_id = $1 AND id = $2`;

/** The FK RESTRICT's check-first backstop (packet §4): counted under the same
 *  lock the delete itself runs under, so nothing can create a new reference
 *  between the check and the DELETE. */
const RULES_REFERENCING_CHANNEL_SQL = `
  SELECT count(*)::int AS n
    FROM alert_rules
   WHERE workspace_id = $1 AND channel_id = $2`;

/** S7.3 (D513): an SLO may reference a channel too, under the same RESTRICT. */
const SLOS_REFERENCING_CHANNEL_SQL = `
  SELECT count(*)::int AS n
    FROM slos
   WHERE workspace_id = $1 AND channel_id = $2`;

/** D489: the rule-count cap closes the abuse hole the eval cadence leaves open
 *  (event production is bounded by cadence × rule count, so rule count must be
 *  bounded too). Generous by design — a workspace at 200 rules is a support
 *  conversation, not a customer to fail. Counted under the same lock the
 *  INSERT runs under. */
export const MAX_ALERT_RULES_PER_WORKSPACE = 200;

const COUNT_RULES_SQL = `
  SELECT count(*)::int AS n
    FROM alert_rules
   WHERE workspace_id = $1`;

/** ONE feed (S7.3 packet §0): a row is a rule's transition, an SLO's
 *  transition (D511 — `slo_id` set, `rule_id` NULL) or a test notification
 *  (both NULL). Both joins are LEFT for the same reason as before. */
const LIST_EVENTS_SQL = `
  SELECT e.id, e.rule_id, r.name AS rule_name, e.slo_id, s.name AS slo_name,
         e.severity, e.title, e.detail, e.link, e.delivery, e.created_at
    FROM alert_events e
    LEFT JOIN alert_rules r ON r.id = e.rule_id
    LEFT JOIN slos s ON s.id = e.slo_id
   WHERE e.workspace_id = $1
   ORDER BY e.created_at DESC
   LIMIT $2`;

const GET_EVENT_SQL = `
  SELECT e.id, e.rule_id, r.name AS rule_name, e.slo_id, s.name AS slo_name,
         e.severity, e.title, e.detail, e.link, e.delivery, e.created_at
    FROM alert_events e
    LEFT JOIN alert_rules r ON r.id = e.rule_id
    LEFT JOIN slos s ON s.id = e.slo_id
   WHERE e.workspace_id = $1 AND e.id = $2`;

/**
 * S7.4 (D530/D534): the incident timeline's ALERTS leg. This read lives here
 * because this module owns `alert_events` — a second module selecting from it
 * would put two owners on one table's read shapes — and it carries the FEED's
 * projection unchanged, so one table's rows have exactly one shape (pinned by
 * `alerts.test.ts`, which compares the two statements' SELECT..JOIN prefixes).
 *
 * Half-open `[from, until)`: incident windows are ADJACENT, so a closed upper
 * bound would let two back-to-back incidents both claim the event at the shared
 * instant with no way to say which owned it. ASC because a timeline reads
 * FORWARD; `e.id` breaks the tie so two events at one instant survive the cap
 * in a stable order. The caller passes `cap + 1` and reads the probe row off
 * the end (D536) — this read does no capping of its own beyond the limit it is
 * handed.
 *
 * `$2`/`$3` are ISO-8601 instants that CARRY their zone (`…Z`): Postgres infers
 * `timestamptz` from the comparison and parses them as UTC, so neither the
 * database server's `TimeZone` nor the runner's local zone can move a boundary
 * (the D179 trap). `alerts.integration.test.ts` proves the boundary against a
 * real Postgres rather than against this comment.
 */
const LIST_EVENTS_IN_WINDOW_SQL = `
  SELECT e.id, e.rule_id, r.name AS rule_name, e.slo_id, s.name AS slo_name,
         e.severity, e.title, e.detail, e.link, e.delivery, e.created_at
    FROM alert_events e
    LEFT JOIN alert_rules r ON r.id = e.rule_id
    LEFT JOIN slos s ON s.id = e.slo_id
   WHERE e.workspace_id = $1 AND e.created_at >= $2 AND e.created_at < $3
   ORDER BY e.created_at, e.id
   LIMIT $4`;

/** D488/D491: a test notification is a rule-less pending event that names its
 *  own channel at emit time — web performs NO egress, the Go deliverer picks
 *  this row up on its own ticker exactly as it would a rule-fired one. */
const INSERT_TEST_EVENT_SQL = `
  INSERT INTO alert_events (workspace_id, id, rule_id, channel_id, severity, title, detail, delivery)
       VALUES ($1, $2, NULL, $3, 'info', 'Test notification', $4, 'pending')`;

/** The UNIQUE key's violation, translated at the one place it can arise
 *  (the `refusingDuplicateName` precedent, D424): refused, never upserted —
 *  an upsert here would silently replace another row's condition or target. */
async function refusingDuplicateName<T>(name: string, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if ((error as { code?: string })?.code === "23505") {
      throw new AlertRefusal(`the name “${name}” is already in use`);
    }
    throw error;
  }
}

function checkedName(name: unknown): string {
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (!trimmed) throw new AlertRefusal("name is required");
  return trimmed;
}

function checkedSeverity(severity: unknown): AlertSeverity {
  if (!SEVERITIES.includes(severity as AlertSeverity)) {
    throw new AlertRefusal(`severity must be one of ${SEVERITIES.join(", ")}`);
  }
  return severity as AlertSeverity;
}

function checkedRunbook(runbook: unknown): string | null {
  if (runbook === null || runbook === undefined) return null;
  if (typeof runbook !== "string") throw new AlertRefusal("runbook must be a URL or nothing at all");
  const trimmed = runbook.trim();
  return trimmed === "" ? null : trimmed;
}

/** D483 (web half): a rule the Go evaluator cannot parse must be unwritable —
 *  judged BEFORE the lock, so an invalid condition costs zero statements
 *  (the D430 shape). */
function checkedCondition(condition: unknown): AlertCondition {
  const result = validateAlertCondition(condition);
  if (!result.ok) throw new AlertRefusal(result.error);
  return result.condition;
}

/** The full editable shape of a rule — everything `createAlertRule` and
 *  `updateAlertRule` accept. `enabled` is deliberately NOT here: it is
 *  `setAlertRuleEnabled`'s alone, so a full-form submit can never flip it by
 *  accident. */
export interface AlertRuleInput {
  name: string;
  condition: unknown;
  severity: AlertSeverity;
  channelId: string;
  runbook: string | null;
}

type CheckedRuleInput = {
  name: string;
  condition: AlertCondition;
  severity: AlertSeverity;
  channelId: string;
  runbook: string | null;
};

/** Shape checks only — no statement runs from here (D430). Channel EXISTENCE
 *  is a database question and is checked by the caller, after the lock. */
function checkedRuleInput(input: AlertRuleInput): CheckedRuleInput {
  const name = checkedName(input.name);
  const condition = checkedCondition(input.condition);
  const severity = checkedSeverity(input.severity);
  const channelId = typeof input.channelId === "string" ? input.channelId.trim() : "";
  if (!channelId) throw new AlertRefusal("a channel is required");
  const runbook = checkedRunbook(input.runbook);
  return { name, condition, severity, channelId, runbook };
}

/** The channel must EXIST in this workspace — enabled or not (packet spec).
 *  Absent here reads exactly as absent everywhere else in this module: the
 *  D440 shape extended to a foreign reference rather than a primary id. */
async function assertChannelExists(workspaceId: string, channelId: string, query: QueryRows): Promise<void> {
  const [row] = await query<{ id: string }>(CHANNEL_EXISTS_SQL, [workspaceId, channelId]);
  if (!row) throw new AlertRefusal(NO_SUCH_CHANNEL);
}

async function readRuleRow(workspaceId: string, id: string, query: QueryRows): Promise<RuleRow> {
  const [row] = await query<RuleRow>(GET_RULE_SQL, [workspaceId, id]);
  if (!row) throw new AlertRefusal(NO_SUCH_RULE);
  return row;
}

async function readBackRule(workspaceId: string, id: string, query: QueryRows): Promise<AlertRuleRow> {
  return toRule(await readRuleRow(workspaceId, id, query));
}

async function readChannelRow(workspaceId: string, id: string, query: QueryRows): Promise<ChannelRow> {
  const [row] = await query<ChannelRow>(GET_CHANNEL_SQL, [workspaceId, id]);
  if (!row) throw new AlertRefusal(NO_SUCH_CHANNEL);
  return row;
}

async function readBackChannel(workspaceId: string, id: string, query: QueryRows): Promise<NotificationChannelRow> {
  return toChannel(await readChannelRow(workspaceId, id, query));
}

/** A limit is a positive integer or it is 1 — the `changes.ts` rule, ONE
 *  definition for the two reads in this module that take one. Extracted from
 *  `listAlertEvents`, whose body spelled it inline: the S7.4 packet (D530) says
 *  both timeline legs pass their limit "through the existing `clampLimit`", and
 *  the existing one lived only in `changes.ts` — a second inline copy here
 *  would have made the packet's sentence true of neither module. */
const clampLimit = (limit: number): number => Math.max(1, Math.floor(limit) || 1);

// ---- reads (packet §0) --------------------------------------------------------

/** This workspace's rules, oldest first — the name breaks the tie (the
 *  `listDashboards` precedent). `condition` is the structured value;
 *  `formatAlertCondition` (T2, `lib/alert-types.ts`) renders the display
 *  string from it — never stored, never a second copy here. */
export async function listAlertRules(workspaceId: string, query: QueryRows): Promise<AlertRuleRow[]> {
  const rows = await query<RuleRow>(LIST_RULES_SQL, [workspaceId]);
  return rows.map(toRule);
}

/** The events feed, newest-first. `ruleId`/`ruleName` are null for a
 *  rule-less (test) event (D491) and for an event whose rule was since
 *  deleted (the join misses, CASCADE means this case cannot actually persist,
 *  but the LEFT JOIN costs nothing to keep honest either way). */
export async function listAlertEvents(
  workspaceId: string,
  limit: number,
  query: QueryRows,
): Promise<AlertEventRow[]> {
  const rows = await query<EventRow>(LIST_EVENTS_SQL, [workspaceId, clampLimit(limit)]);
  return rows.map(toEvent);
}

/**
 * The alert events inside one incident's window, OLDEST first — the timeline's
 * alerts leg (D530). The window is half-open `[fromIso, untilIso)` and both
 * bounds come from the caller: the stitcher samples ONE clock in TS and binds
 * it to all three legs (D534), so this function never reads a clock of its own
 * and there is no `now()` in the statement it runs.
 *
 * The rows come back in the same `AlertEventRow` shape the feed returns, mapped
 * at the same one point.
 */
export async function listAlertEventsInWindow(
  workspaceId: string,
  fromIso: string,
  untilIso: string,
  limit: number,
  query: QueryRows,
): Promise<AlertEventRow[]> {
  const rows = await query<EventRow>(LIST_EVENTS_IN_WINDOW_SQL, [
    workspaceId,
    fromIso,
    untilIso,
    clampLimit(limit),
  ]);
  return rows.map(toEvent);
}

/** This workspace's channels. `targetMasked` is ALWAYS the masked form
 *  (D487) — the full `target` column is never selected bare by any exported
 *  function in this module. */
export async function listNotificationChannels(
  workspaceId: string,
  query: QueryRows,
): Promise<NotificationChannelRow[]> {
  const rows = await query<ChannelRow>(LIST_CHANNELS_SQL, [workspaceId]);
  return rows.map(toChannel);
}

// ---- rule mutations ------------------------------------------------------------

/** Create a rule. Shape is judged before the lock; the channel's EXISTENCE and
 *  the name's UNIQUEness are database questions and are judged after it
 *  (D429/D430). An unevaluatable condition never reaches Postgres at all. */
export async function createAlertRule(
  workspaceId: string,
  input: AlertRuleInput,
  query: TxQuery,
): Promise<AlertRuleRow> {
  const checked = checkedRuleInput(input);
  await lockWorkspace(query, workspaceId);

  const [{ n }] = await query<{ n: number }>(COUNT_RULES_SQL, [workspaceId]);
  if (n >= MAX_ALERT_RULES_PER_WORKSPACE) {
    throw new AlertRefusal(
      `this workspace already has ${MAX_ALERT_RULES_PER_WORKSPACE} alert rules — the maximum`,
    );
  }

  await assertChannelExists(workspaceId, checked.channelId, query);

  const id = newRuleId();
  await refusingDuplicateName(checked.name, () =>
    query(INSERT_RULE_SQL, [
      workspaceId,
      id,
      checked.name,
      JSON.stringify(checked.condition),
      checked.severity,
      checked.channelId,
      checked.runbook,
    ]),
  );
  return readBackRule(workspaceId, id, query);
}

/** Update a rule's editable content. Never touches `enabled`, `state`,
 *  `last_triggered_at` or `next_eval_at` — those are `setAlertRuleEnabled`'s
 *  and the evaluator's alone. The workspace cannot be changed: it is not part
 *  of `AlertRuleInput` and the WHERE clause is the only place it appears. */
export async function updateAlertRule(
  workspaceId: string,
  id: string,
  input: AlertRuleInput,
  query: TxQuery,
): Promise<AlertRuleRow> {
  const checked = checkedRuleInput(input);
  await lockWorkspace(query, workspaceId);
  await readRuleRow(workspaceId, id, query);
  await assertChannelExists(workspaceId, checked.channelId, query);

  await refusingDuplicateName(checked.name, () =>
    query(UPDATE_RULE_SQL, [
      workspaceId,
      id,
      checked.name,
      JSON.stringify(checked.condition),
      checked.severity,
      checked.channelId,
      checked.runbook,
    ]),
  );
  return readBackRule(workspaceId, id, query);
}

/** Enable or disable a rule — the toggle in the rules list, independent of the
 *  edit form (`updateAlertRule`). */
export async function setAlertRuleEnabled(
  workspaceId: string,
  id: string,
  enabled: boolean,
  query: TxQuery,
): Promise<AlertRuleRow> {
  if (typeof enabled !== "boolean") throw new AlertRefusal("enabled is true or false");
  await lockWorkspace(query, workspaceId);
  await readRuleRow(workspaceId, id, query);

  await query(SET_RULE_ENABLED_SQL, [workspaceId, id, enabled]);
  return readBackRule(workspaceId, id, query);
}

/** Drop a rule and answer with the workspace's remaining list (the
 *  `deleteDashboard` shape): an id this workspace does not hold matches no
 *  row and gets the same list a stale tab would get. Its events CASCADE
 *  (0010's own FK) — an event has no meaning once its rule is gone. */
export async function deleteAlertRule(workspaceId: string, id: string, query: TxQuery): Promise<AlertRuleRow[]> {
  await lockWorkspace(query, workspaceId);
  await query(DELETE_RULE_SQL, [workspaceId, id]);
  return listAlertRules(workspaceId, query);
}

// ---- channel mutations ----------------------------------------------------------

/** What `createNotificationChannel` accepts. `target` is stored AS GIVEN
 *  (the `api_keys` plaintext-at-rest posture, D487): it must parse as a URL,
 *  but https is NOT enforced here — egress policy is the notifier's alone
 *  (packet spec, amended D492), so a scheme this module rejected here would
 *  be a rule this module invented rather than one the packet states. */
export interface NewNotificationChannel {
  name: string;
  kind: NotificationChannelKind;
  target: string;
}

function checkedChannelInput(input: NewNotificationChannel): { name: string; kind: NotificationChannelKind; target: string } {
  const name = checkedName(input.name);
  if (!CHANNEL_KINDS.includes(input.kind)) {
    throw new AlertRefusal(`kind must be one of ${CHANNEL_KINDS.join(", ")}`);
  }
  const target = typeof input.target === "string" ? input.target.trim() : "";
  if (!target) throw new AlertRefusal("target is required");
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    throw new AlertRefusal("target must be a valid URL");
  }
  // https is deliberately NOT enforced here — egress policy (scheme, private
  // ranges, literal IPs) is the notifier's alone (D492); a host is required
  // only so `maskTarget` never renders a freshly created channel as invalid.
  if (!parsed.host) throw new AlertRefusal("target must be a valid URL");
  return { name, kind: input.kind, target };
}

/** Create a channel. Shape (including "does this parse as a URL") is judged
 *  before the lock; the name's UNIQUEness is Postgres's (D424 shape). */
export async function createNotificationChannel(
  workspaceId: string,
  input: NewNotificationChannel,
  query: TxQuery,
): Promise<NotificationChannelRow> {
  const checked = checkedChannelInput(input);
  await lockWorkspace(query, workspaceId);

  const id = newChannelId();
  await refusingDuplicateName(checked.name, () =>
    query(INSERT_CHANNEL_SQL, [workspaceId, id, checked.name, checked.kind, checked.target]),
  );
  return readBackChannel(workspaceId, id, query);
}

/** Enable or disable a channel. A disabled channel still EXISTS for
 *  `assertChannelExists` — a rule may point at it, it simply is not
 *  delivered to (the deliverer's own read, not this module's concern). */
export async function setNotificationChannelEnabled(
  workspaceId: string,
  id: string,
  enabled: boolean,
  query: TxQuery,
): Promise<NotificationChannelRow> {
  if (typeof enabled !== "boolean") throw new AlertRefusal("enabled is true or false");
  await lockWorkspace(query, workspaceId);
  await readChannelRow(workspaceId, id, query);

  await query(SET_CHANNEL_ENABLED_SQL, [workspaceId, id, enabled]);
  return readBackChannel(workspaceId, id, query);
}

/** Drop a channel — REFUSED while any rule OR SLO in this workspace references it
 *  (packet §4: the FK is `ON DELETE RESTRICT`, and this is the check-first
 *  that turns that constraint into a typed refusal instead of a 500). The
 *  check runs under the same advisory lock the delete does, so nothing can
 *  create a new reference in between; the `23503` catch below is a backstop
 *  for the same constraint, not the primary path. Deletable again the moment
 *  the last referencing rule is gone. */
export async function deleteNotificationChannel(
  workspaceId: string,
  id: string,
  query: TxQuery,
): Promise<NotificationChannelRow[]> {
  await lockWorkspace(query, workspaceId);
  const row = await readChannelRow(workspaceId, id, query);

  const [{ n }] = await query<{ n: number }>(RULES_REFERENCING_CHANNEL_SQL, [workspaceId, id]);
  const [{ n: slos }] = await query<{ n: number }>(SLOS_REFERENCING_CHANNEL_SQL, [workspaceId, id]);
  if (n > 0 || slos > 0) {
    const users = [
      n > 0 ? `${n} alert rule${n === 1 ? "" : "s"}` : null,
      slos > 0 ? `${slos} SLO${slos === 1 ? "" : "s"}` : null,
    ].filter((u): u is string => u !== null);
    const pronoun = n + slos === 1 ? "it" : "them";
    throw new AlertRefusal(`“${row.name}” is used by ${users.join(" and ")} — delete or repoint ${pronoun} first`);
  }

  try {
    await query(DELETE_CHANNEL_SQL, [workspaceId, id]);
  } catch (error) {
    if ((error as { code?: string })?.code === "23503") {
      throw new AlertRefusal(`“${row.name}” is used by an alert rule or an SLO — delete or repoint it first`);
    }
    throw error;
  }
  return listNotificationChannels(workspaceId, query);
}

// ---- test notifications (D488/D491) --------------------------------------------

/**
 * The notifier's front door, not a bypass (D488): this inserts exactly one
 * `pending`, rule-less event captured against the named channel, at `info`
 * severity, with the detail naming the channel's NAME — never its target.
 * Web performs NO egress; the Go deliverer (a separate ticker, D490) claims
 * this row on its own cadence and attempts real delivery through the same
 * fences and retry a rule-fired event gets, so the outcome the surface later
 * shows (`delivered`/`failed`) is the real one.
 */
export async function sendTestNotification(
  workspaceId: string,
  channelId: string,
  query: TxQuery,
): Promise<AlertEventRow> {
  await lockWorkspace(query, workspaceId);
  const channel = await readChannelRow(workspaceId, channelId, query);

  const id = newEventId();
  const detail = `Manual test notification for channel “${channel.name}”.`;
  await query(INSERT_TEST_EVENT_SQL, [workspaceId, id, channelId, detail]);

  const [row] = await query<EventRow>(GET_EVENT_SQL, [workspaceId, id]);
  return toEvent(row);
}
