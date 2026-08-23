import { redirect } from "next/navigation";
import { connection } from "next/server";
import { ConnectionsHub } from "@/components/connections/ConnectionsHub";
import { dataMode } from "@/server/data";
import {
  getAcceptedRates,
  getIngestHealth,
  RATE_WINDOW_MINUTES,
} from "@/server/ingest-health";
import { resolveIngestEndpoints } from "@/server/ingest-endpoint";
import { connectedSources } from "@/mock/connectors";
import { queryRows } from "@/server/postgres";
import { getSessionContext } from "@/server/session";

/** UTC on the server, like every other rendered instant (settings/page.tsx). */
const asMinute = (at: Date): string => `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;

/**
 * The connections hub's one read.
 *
 * Mock mode returns FIRST, before `connection()` and before anything
 * session-shaped (D125): the demo deployment has no accounts and no Postgres,
 * so the fabricated sample sources are handed to the hub from HERE — the
 * component itself imports no `@/mock/*` data, because it also renders for a
 * real workspace (D204/D208; the cards are the same definition in both modes).
 *
 * Live mode reads `getIngestHealth` and nothing else: the D100 `api_key_health`
 * rows are the ONE counter path in the product (S3.3 exit bundle §6.4), so what
 * this page shows per key is what the metering flush wrote, formatted, with the
 * freshest row's `updated_at` carried as the panel's "as of". No span query
 * counts the same events a second way.
 */
export default async function ConnectionsPage() {
  if (dataMode !== "live") {
    return <ConnectionsHub data={{ mode: "demo", sources: connectedSources }} />;
  }
  await connection();

  const session = await getSessionContext();
  // The layout redirects too, but a layout does not control whether the segment
  // below it renders: this page resolves its own session rather than reading a
  // workspace off a null.
  if (!session) redirect("/login");

  // Two reads, in parallel: the cumulative health rows every live surface uses,
  // and the windowed rate only this panel renders (D260 — kept a separate read
  // so the onboarding poll does not pay for a number it never shows).
  const [health, rates] = await Promise.all([
    getIngestHealth(session.workspaceId, queryRows),
    getAcceptedRates(session.workspaceId, queryRows),
  ]);

  // A field copy and two date formats. The drop counts cross RAW — which of
  // them is an error and which is the plan's sampling is the hub's one
  // classification (`sourceErrors`), stated once where it is rendered.
  return (
    <ConnectionsHub
      data={{
        mode: "live",
        sources: health.keys.map((key) => ({
          keyId: key.keyId,
          name: key.name,
          prefix: key.prefix,
          revoked: key.revoked,
          accepted: key.accepted,
          droppedDecode: key.droppedDecode,
          droppedUnsupported: key.droppedUnsupported,
          droppedQuota: key.droppedQuota,
          lastEvent: key.lastEventAt ? asMinute(key.lastEventAt) : null,
          // D260: the measured rate crosses as the number it is; the window it
          // was measured over crosses beside it so the panel can say so.
          ratePerMin: rates.get(key.keyId) ?? null,
        })),
        asOf: health.asOf ? asMinute(health.asOf) : null,
        rateWindowMinutes: RATE_WINDOW_MINUTES,
      }}
      // D281: resolved after `connection()`, so the read is request-time (the
      // D266 no-build-time-baking rule); the modal substitutes its endpoint
      // placeholders from this pair and renders honest absences (D282) for
      // protocols this deployment does not publish.
      endpoints={resolveIngestEndpoints()}
    />
  );
}
