import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import {
  SettingsSuite,
  type LiveBilling,
  type LiveIngest,
  type LiveSettings,
} from "@/components/settings/SettingsSuite";
import { listApiKeys } from "@/server/api-keys";
import { CHECKOUT_RETURN_PARAM, reconcileCheckout } from "@/server/billing";
import { dataMode } from "@/server/data";
import {
  BASE_PRICES_AS_OF,
  BASE_PRICES_COUNT,
  OVERRIDE_MAX,
  getIngestHealth,
  listPricingOverrides,
} from "@/server/ingest-health";
import { getOrgName, inviteLinkPath, listOrgMembers, listPendingInvites } from "@/server/invites";
import { queryRows } from "@/server/postgres";
import { getSessionContext } from "@/server/session";
import { getUsage, listPlans } from "@/server/usage";
import { settingsErrorMessage } from "./errors";

/**
 * The reads of the settings surface; the writes are `actions.ts`.
 *
 * Mock mode returns FIRST, before `connection()` and before `searchParams` is
 * awaited, and that ordering is the whole of D125 here: the demo product has no
 * accounts and no Postgres, so this page must reach for neither — and a page
 * that awaited a request-time API above the mode check would also stop being
 * prerenderable in a mock build, which is a behaviour change to every visitor of
 * the demo for the sake of a branch they never take.
 *
 * Live mode is per-request by construction — whose org, whose keys — so it holds
 * for a real request (D27a) and reads through the session context. Everything
 * below is scoped by `session.orgId`/`session.workspaceId` and nothing on this
 * page takes a tenant from the URL (D148).
 */

/**
 * UTC, and formatted here rather than in the client component: a date formatted
 * on both sides of hydration is formatted in two timezones. Minute precision on
 * an expiry because better-auth's invitations last 48 hours (measured) — a
 * day-only rendering of "expires" would round a link's death by half a day.
 */
const asDay = (at: Date): string => at.toISOString().slice(0, 10);
const asMinute = (at: Date): string => `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;
const asMonth = (at: Date): string =>
  `${at.toLocaleString("en-US", { month: "long", timeZone: "UTC" })} ${at.getUTCFullYear()}`;

/**
 * The checkout return, which is D110's poll-on-return: the customer comes back
 * from Polar with `?checkout=<id>` and the plan row is written HERE, by reading
 * the checkout's real state, rather than by trusting the browser that arrived.
 * The webhook reconciles the same way for the customer who never comes back —
 * one function, two callers (D168), which is why nothing about a plan is decided
 * in this file.
 *
 * The parameter is a URL value, so it is parsed totally (D68): absent, repeated
 * and non-string all mean "no return to reconcile". A billing outage is caught
 * and reported as `failed` — a settings page that 500s because Polar is
 * unreachable would take the roster, the keys and the meter down with it, and
 * the reconciler will catch up on its own.
 */
async function applyCheckoutReturn(
  raw: string | string[] | undefined,
  workspaceId: string,
): Promise<LiveBilling["checkout"]> {
  if (raw === undefined) return null;
  const checkoutId = Array.isArray(raw) ? raw[0] : raw;
  if (typeof checkoutId !== "string" || checkoutId === "") return null;

  try {
    const result = await reconcileCheckout(checkoutId, workspaceId, queryRows);
    if (result.applied) return "applied";
    return result.reason === "pending" ? "pending" : "failed";
  } catch (error) {
    console.error("[settings] checkout return", error);
    return "failed";
  }
}

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[]; [CHECKOUT_RETURN_PARAM]?: string | string[] }>;
}) {
  if (dataMode !== "live") return <SettingsSuite live={null} />;
  await connection();

  const session = await getSessionContext();
  // The layout redirects too, but a layout does not control whether the segment
  // below it renders (its own note): this page resolves its own session, so it
  // answers for itself rather than reading a workspace off a null.
  if (!session) redirect("/login");

  // Before the reads, not beside them: a returning checkout writes the plan row,
  // and the meter below has to be measured against the plan the customer just
  // bought rather than the one they had a second ago.
  const params = await searchParams;
  const checkout = await applyCheckoutReturn(params[CHECKOUT_RETURN_PARAM], session.workspaceId);

  const requestHeaders = await headers();
  const [orgName, members, invites, keys, usage, plans, health, overrides] = await Promise.all([
    getOrgName(session.orgId, queryRows),
    listOrgMembers(session.orgId, queryRows),
    listPendingInvites(session.orgId, requestHeaders),
    listApiKeys(session.workspaceId, queryRows),
    getUsage(session.workspaceId, queryRows),
    listPlans(queryRows),
    getIngestHealth(session.workspaceId, queryRows),
    listPricingOverrides(session.workspaceId, queryRows),
  ]);

  // A member row pointing at an organization that does not exist is the same
  // class of half-state `resolveSessionContext` refuses to paper over: loud
  // here beats a settings page that names the workspace after nobody.
  if (!orgName) throw new Error(`organization ${session.orgId} has no row`);

  // Which plans can be BOUGHT is decided here, on the server, and it is decided
  // by price against the catalog rather than by a list of plan names: a plan
  // costing more than the current one is an upgrade, and everything else is not
  // offered, because a checkout is how you pay more and not how you pay less.
  // Cancelling a subscription is Polar's own surface (D110 — merchant of record).
  const currentPrice = plans.find((plan) => plan.id === usage.planId)?.priceUsdMonth ?? 0;

  const billing: LiveBilling = {
    planName: usage.planName,
    eventsUsed: usage.eventsUsed,
    eventQuota: usage.eventQuota,
    retentionDays: usage.retentionDays,
    periodStart: asMonth(usage.periodStart),
    asOf: usage.asOf ? asMinute(usage.asOf) : null,
    plans: plans.map((plan) => ({
      id: plan.id,
      name: plan.name,
      priceUsdMonth: plan.priceUsdMonth,
      eventQuota: plan.eventQuota,
      retentionDays: plan.retentionDays,
      upgrade: plan.priceUsdMonth > currentPrice,
    })),
    checkout,
  };

  // The Data & ingest tab, read HERE like every other tab's rows (D182): a tab
  // is a view of this page's props and not a surface that fetches itself, so
  // opening it costs no roundtrip and its writes hand back the same rows this
  // read produces. The two totals it shows are the store's sums of the same
  // rows listed under them — nothing on this page adds a column up twice.
  const ingest: LiveIngest = {
    keys: health.keys.map((key) => ({
      keyId: key.keyId,
      name: key.name,
      prefix: key.prefix,
      revoked: key.revoked,
      accepted: key.accepted,
      errors: key.droppedDecode + key.droppedUnsupported,
      sampled: key.droppedQuota,
      lastEvent: key.lastEventAt ? asMinute(key.lastEventAt) : null,
    })),
    accepted: health.accepted,
    receiveErrors: health.receiveErrors,
    droppedQuota: health.droppedQuota,
    asOf: health.asOf ? asMinute(health.asOf) : null,
    overrides: overrides.map((override) => ({
      id: override.id,
      match: override.match,
      inputPerMTok: override.inputPerMTok,
      outputPerMTok: override.outputPerMTok,
      updated: asDay(override.updatedAt),
    })),
    overrideMax: OVERRIDE_MAX,
    pricesAsOf: BASE_PRICES_AS_OF,
    pricedModels: BASE_PRICES_COUNT,
  };

  const live: LiveSettings = {
    orgName,
    workspaceId: session.workspaceId,
    members,
    invites: invites.map((invite) => ({
      id: invite.id,
      email: invite.email,
      linkPath: inviteLinkPath(invite.id),
      expires: asMinute(invite.expiresAt),
    })),
    keys: keys.map((key) => ({
      id: key.id,
      name: key.name,
      prefix: key.prefix,
      created: asDay(key.createdAt),
      revoked: key.revokedAt ? asDay(key.revokedAt) : null,
    })),
    billing,
    ingest,
    // The code from the URL is mapped to fixed copy and never rendered (D121).
    errorMessage: settingsErrorMessage(params.error),
  };

  return <SettingsSuite live={live} />;
}
