"use server";

import type {
  AlertEventRow,
  AlertRuleRow,
  NotificationChannelRow,
} from "@/lib/alert-types";
import { dataMode } from "@/server/data";
import * as store from "@/server/alerts";
import { withTransaction, type TxQuery } from "@/server/postgres";
import { getSessionContext } from "@/server/session";

/**
 * The calls the rules list, the rule editor, channel management and the
 * test-notification button make (T6). The `components/dashboards/actions.ts`
 * shape exactly: a Server Function is reachable by a direct POST and not only
 * through the UI, so the workspace is resolved from the session HERE, on
 * every call — the client names a rule or a channel, never a workspace.
 *
 * MUTATIONS ONLY (S6.3-L2/D441). Reading rules, events and channels is the
 * PAGE's job — the live branch of `alerts/page.tsx` calls `server/alerts.ts`
 * directly on its own request — so there is exactly one definition of what a
 * surface shows, and no read of this store is reachable as a POST endpoint.
 *
 * `null` is the answer when there is no workspace to act in — mock mode,
 * which has none and must not touch Postgres at all (D114), or a caller with
 * no session.
 *
 * Every mutation runs inside `withTransaction` so `server/alerts.ts`'s
 * advisory lock (D195/D197/D199) actually holds across its read→write.
 * Refusals arrive as `store.AlertRefusal` and become `{ refused }` — the
 * sentence the surface prints verbatim (D430/D436 idiom); every OTHER
 * failure propagates, so a real outage is never dressed up as a refusal.
 *
 * Nothing here revalidates: callers call `router.refresh()` after a result,
 * so the fresh page read is the one definition of what the surface shows.
 */
async function activeWorkspace(): Promise<string | null> {
  if (dataMode !== "live") return null;
  const session = await getSessionContext();
  return session?.workspaceId ?? null;
}

export type AlertRuleActionResult = { rule: AlertRuleRow } | { refused: string } | null;
export type NotificationChannelActionResult = { channel: NotificationChannelRow } | { refused: string } | null;
export type DeleteChannelActionResult = { channels: NotificationChannelRow[] } | { refused: string } | null;
export type TestNotificationActionResult = { event: AlertEventRow } | { refused: string } | null;

/** The one rule-mutation shape: session → transaction → the fresh row, or the sentence. */
async function mutateRule(
  write: (workspaceId: string, query: TxQuery) => Promise<AlertRuleRow>,
): Promise<AlertRuleActionResult> {
  const workspaceId = await activeWorkspace();
  if (workspaceId === null) return null;
  try {
    return { rule: await withTransaction((query) => write(workspaceId, query)) };
  } catch (failure) {
    if (failure instanceof store.AlertRefusal) return { refused: failure.message };
    throw failure;
  }
}

/** The one channel-mutation shape, same discipline. */
async function mutateChannel(
  write: (workspaceId: string, query: TxQuery) => Promise<NotificationChannelRow>,
): Promise<NotificationChannelActionResult> {
  const workspaceId = await activeWorkspace();
  if (workspaceId === null) return null;
  try {
    return { channel: await withTransaction((query) => write(workspaceId, query)) };
  } catch (failure) {
    if (failure instanceof store.AlertRefusal) return { refused: failure.message };
    throw failure;
  }
}

export async function createAlertRule(input: store.AlertRuleInput): Promise<AlertRuleActionResult> {
  return mutateRule((workspaceId, query) => store.createAlertRule(workspaceId, input, query));
}

export async function updateAlertRule(id: string, input: store.AlertRuleInput): Promise<AlertRuleActionResult> {
  return mutateRule((workspaceId, query) => store.updateAlertRule(workspaceId, id, input, query));
}

export async function setAlertRuleEnabled(id: string, enabled: boolean): Promise<AlertRuleActionResult> {
  return mutateRule((workspaceId, query) => store.setAlertRuleEnabled(workspaceId, id, enabled, query));
}

/** The fresh LIST, not a row: the rule the caller named is gone. Never
 *  refuses — an id this workspace does not hold matches no row and the
 *  answer is the workspace's own list unchanged (the `deleteDashboard`
 *  shape); its events CASCADE with it. */
export async function deleteAlertRule(id: string): Promise<AlertRuleRow[] | null> {
  const workspaceId = await activeWorkspace();
  if (workspaceId === null) return null;
  return withTransaction((query) => store.deleteAlertRule(workspaceId, id, query));
}

export async function createNotificationChannel(
  input: store.NewNotificationChannel,
): Promise<NotificationChannelActionResult> {
  return mutateChannel((workspaceId, query) => store.createNotificationChannel(workspaceId, input, query));
}

export async function setNotificationChannelEnabled(
  id: string,
  enabled: boolean,
): Promise<NotificationChannelActionResult> {
  return mutateChannel((workspaceId, query) => store.setNotificationChannelEnabled(workspaceId, id, enabled, query));
}

/** Unlike a rule, a channel delete CAN be refused (the FK RESTRICT surfaced
 *  as a typed error while a rule still references it) — so this answers with
 *  the fresh list on success and `{ refused }` on the same sentence
 *  `server/alerts.ts` raises, never a 500. */
export async function deleteNotificationChannel(id: string): Promise<DeleteChannelActionResult> {
  const workspaceId = await activeWorkspace();
  if (workspaceId === null) return null;
  try {
    return { channels: await withTransaction((query) => store.deleteNotificationChannel(workspaceId, id, query)) };
  } catch (failure) {
    if (failure instanceof store.AlertRefusal) return { refused: failure.message };
    throw failure;
  }
}

/** D488: walks the real notifier front door — inserts a pending, rule-less
 *  event against the named channel. Web performs NO egress; the Go
 *  deliverer picks the row up on its own ticker. */
export async function sendTestNotification(channelId: string): Promise<TestNotificationActionResult> {
  const workspaceId = await activeWorkspace();
  if (workspaceId === null) return null;
  try {
    return { event: await withTransaction((query) => store.sendTestNotification(workspaceId, channelId, query)) };
  } catch (failure) {
    if (failure instanceof store.AlertRefusal) return { refused: failure.message };
    throw failure;
  }
}
