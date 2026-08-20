import { redirect } from "next/navigation";
import { connection } from "next/server";
import { DemoArrival } from "@/components/onboarding/DemoArrival";
import { Quickstart } from "@/components/onboarding/Quickstart";
import { dataForSessionContext, dataMode } from "@/server/data";
import { getOnboardingStatus } from "@/server/onboarding";
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
  // The demo's arrival panel is passed in, not imported by `Quickstart` (D217):
  // the mock rows are reached from this branch alone, so the live render below
  // has no path to `@/mock/*` — in the bundle, not only in the JSX.
  if (dataMode !== "live") return <Quickstart demoArrival={<DemoArrival />} />;
  await connection();

  const session = await getSessionContext();
  // The layout redirects too, but a layout does not control whether the segment
  // below it renders: this page resolves its own session rather than reading a
  // workspace off a null.
  if (!session) redirect("/login");

  // The poll route answers with this same function (D209), so the first paint
  // and every update after it are the one status.
  const status = await getOnboardingStatus(
    session.workspaceId,
    dataForSessionContext(session),
    queryRows,
  );

  // Exactly the D209-as-amended props and nothing beside them (D215 deleted the
  // `endpoint` prop — the component imports `lib/ingest-endpoint`'s constant
  // directly, like the connector steps do). No existing-key list either: a
  // stored token is unrecoverable (D98), so a prefix is not something anyone can
  // paste into a snippet — which is why D201 put issuance on this surface in the
  // first place. Listing keys here would render a column no step can use.
  return <Quickstart initialStatus={status} issueKey={issueQuickstartKey} />;
}
