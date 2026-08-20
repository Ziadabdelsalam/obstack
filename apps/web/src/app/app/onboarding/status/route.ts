import { dataForSessionContext, dataMode } from "@/server/data";
import { getOnboardingStatus } from "@/server/onboarding";
import { queryRows } from "@/server/postgres";
import { getSessionContext } from "@/server/session";

/**
 * The quickstart's poll (D203): the waiting panel asks this every 5s — the flush
 * cadence the counters behind it move at — and stops asking on arrival. It is a
 * GET because a read is a read (D189); `router.refresh()` was refused, because
 * re-rendering a whole route to learn one boolean is a page load per five
 * seconds.
 *
 * It answers with `getOnboardingStatus`, the SAME function the page's first
 * render calls, so the poll cannot disagree with the render it updates (D209).
 *
 * Scoped by the session and by nothing else: the workspace comes from the
 * cookie's resolved context, never from the URL, so there is no parameter here
 * for a caller to point at someone else's data (D96/D148).
 */
export async function GET(): Promise<Response> {
  // Mock mode ingests nothing and its panel never polls, so a request here came
  // from somewhere no visitor can be — 404, because this route does not exist in
  // that deployment, plus the tripwire log at error level (D193: it cannot occur
  // through honest use).
  if (dataMode === "mock") {
    console.error("[onboarding] status polled in mock mode — this deployment ingests nothing");
    return new Response(null, { status: 404 });
  }

  const session = await getSessionContext();
  // A poll is not a navigation: an unauthenticated caller gets the status code
  // rather than a login page rendered inside a JSON response.
  if (!session) return new Response(null, { status: 401 });

  const status = await getOnboardingStatus(
    session.workspaceId,
    dataForSessionContext(session),
    queryRows,
  );
  // `no-store` is the point of a poll: the same URL every five seconds is
  // exactly the shape a browser cache would answer for us.
  return Response.json(status, { headers: { "cache-control": "no-store" } });
}
