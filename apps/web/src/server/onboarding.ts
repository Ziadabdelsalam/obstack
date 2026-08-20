import "server-only";
import type { WorkspaceData } from "@/server/data";
import { getIngestHealth } from "@/server/ingest-health";
import type { QueryRows } from "@/server/postgres";

/**
 * What the quickstart's waiting panel knows, and the ONLY shape it knows it in
 * (D209): the server read below builds it for the first render, and the GET
 * handler beside the page (`app/app/onboarding/status/route.ts`) answers the
 * poll with the same function's result — one definition, so a panel that flips
 * on the poll flips on a reload for the same reason.
 *
 * `asOf` is a formatted instant rather than a Date because it crosses to a
 * client component AND crosses JSON: two carriers, one representation.
 */
export type OnboardingStatus = {
  arrived: boolean;
  firstTrace: { id: string } | null;
  asOf: string | null;
};

/**
 * Where this deployment's OTLP actually listens — the endpoint the quickstart
 * and the connector steps tell an operator to export to (D101: the
 * environment's real endpoint, never a hosted name we do not run).
 *
 * The default is compose's published OTLP/HTTP port (`docker-compose.yml`:
 * `127.0.0.1:4318`), which is what the e2e drive sends to and what a developer
 * running the stack locally has; a deployment that publishes it elsewhere sets
 * the variable. There is no hosted obstack to fall back to (U1).
 */
export const INGEST_ENDPOINT = process.env.OBSTACK_INGEST_ENDPOINT ?? "http://127.0.0.1:4318";

/** UTC on the server, like every other rendered instant (settings/page.tsx). */
const asMinute = (at: Date): string => `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;

/**
 * Has this workspace's data arrived, and what is the trace to link?
 *
 * Arrival is the D100 counters and nothing else (D203): `getIngestHealth` is the
 * one counter path in the product, and its per-key `lastEventAt` is the
 * predicate — a key with an event timestamp is a key something reached us on.
 * The staleness the panel shows is the same read's `asOf`, so "arrived" and "as
 * of" can never come from two different moments.
 *
 * The trace link is a RESOLVER, not a second arrival signal: it runs only after
 * the counters say yes, and it goes through the workspace-scoped facade (D96/
 * D113) like every other read of ingested rows. Between the counter flush and
 * the row being queryable there is a window where health says arrived and the
 * search answers nothing — that window returns `arrived: true, firstTrace:
 * null`, and the panel keeps waiting on the LINK (D203). Reporting `arrived:
 * false` there would be this module lying about its own counters.
 *
 * Which trace: the newest one the default window holds. For the workspace this
 * panel exists for — one that just sent its first data — the newest trace IS
 * its first, and the search contract answers newest-first (D44); paging to the
 * true oldest would be a second round trip for a workspace that has one row.
 *
 * `query` and `data` are both injected (D113/D181), so the whole function is
 * drivable with no Postgres and no ClickHouse.
 */
export async function getOnboardingStatus(
  workspaceId: string,
  data: Pick<WorkspaceData, "searchTraces">,
  query: QueryRows,
): Promise<OnboardingStatus> {
  const health = await getIngestHealth(workspaceId, query);
  const arrived = health.keys.some((key) => key.lastEventAt !== null);
  const asOf = health.asOf ? asMinute(health.asOf) : null;

  if (!arrived) return { arrived: false, firstTrace: null, asOf };

  const { traces } = await data.searchTraces({});
  const first = traces[0];
  return { arrived: true, firstTrace: first ? { id: first.id } : null, asOf };
}
