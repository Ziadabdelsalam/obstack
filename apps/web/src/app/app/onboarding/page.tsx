import { redirect } from "next/navigation";
import { connection } from "next/server";
import { Quickstart } from "@/components/onboarding/Quickstart";
import { listApiKeys } from "@/server/api-keys";
import { dataForSessionContext, dataMode } from "@/server/data";
import { INGEST_ENDPOINT, getOnboardingStatus } from "@/server/onboarding";
import { queryRows } from "@/server/postgres";
import { getSessionContext } from "@/server/session";
import { issueQuickstartKey } from "./actions";

/**
 * The quickstart's reads; its one write is `actions.ts`.
 *
 * Mock mode returns FIRST, before `connection()` and before anything
 * session-shaped, and that ordering is D125 here: the demo deployment has no
 * accounts and no Postgres, so this page must reach for neither — it renders
 * exactly the component the demo has always rendered.
 *
 * Live mode is per-request by construction (whose workspace, whose keys, whose
 * data), so it holds for a real request (D27a) and everything below is scoped by
 * `session.workspaceId`.
 */
export default async function OnboardingPage() {
  if (dataMode !== "live") return <Quickstart />;
  await connection();

  const session = await getSessionContext();
  // The layout redirects too, but a layout does not control whether the segment
  // below it renders: this page resolves its own session rather than reading a
  // workspace off a null.
  if (!session) redirect("/login");

  const [status, keys] = await Promise.all([
    // The poll route answers with this same function (D209), so the first paint
    // and every update after it are the one status.
    getOnboardingStatus(session.workspaceId, dataForSessionContext(session), queryRows),
    listApiKeys(session.workspaceId, queryRows),
  ]);

  return (
    <Quickstart
      initialStatus={status}
      endpoint={INGEST_ENDPOINT}
      // Prefixes only — a stored token is unrecoverable (D98), so what an
      // existing key can show is what it is, not what to paste. Revoked keys are
      // left out: this surface is about getting data in, and a dead key is
      // settings' business.
      keys={keys
        .filter((key) => key.revokedAt === null)
        .map((key) => ({ id: key.id, name: key.name, prefix: key.prefix }))}
      issueKey={issueQuickstartKey}
    />
  );
}
