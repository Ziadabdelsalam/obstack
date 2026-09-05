import { incidents } from "@/mock/incident";
import { IncidentsMock } from "@/components/incidents/IncidentsMock";
import { IncidentNotFound } from "@/components/incidents/IncidentNotFound";

/**
 * The mock branch of `/app/incidents/[id]` — a ROUTER, not a screen (S7.4
 * packet D520).
 *
 * Master renders ONE incident, the fixture `incidents[0]`, as a detail view at
 * the LIST url, and D519 pins that body byte for byte in `IncidentsMock`. The
 * `[id]` route is net-new this sprint and the demo has no second body to show
 * at it, so this file authors none: the fixture's own id renders the pinned
 * body, and any other id renders the one D436 sentence (`IncidentNotFound`),
 * which the live detail renders too. The ONLY net-new mock DOM this sprint
 * ships is that sentence, and it has a single definition.
 *
 * Rejected, with the packet's reasons: `notFound()` (no `not-found.tsx` in the
 * repo, so a demo visitor would leave the app shell — D125's honest-absence
 * precedent is a RENDERED sentence, not a 404); and rendering the fixture for
 * ANY id (that asserts the id the visitor typed IS the demo's incident —
 * invented data in the one place the demo has no cover).
 *
 * It takes the `params` PROMISE and awaits it itself (the
 * `dashboards/[id]/page.tsx:31` shape): the page hands the promise through
 * before its own first await, which is what keeps the mock branch ahead of
 * every live-only read (D431). The comparison is against the fixture's id as
 * the fixture states it — never a typed `"INC-42"`, which would be a second
 * copy of a string the mock owns.
 *
 * No sha pin: master holds one body and it is pinned once. A digest of a file
 * invented this sprint would prove nothing master ever rendered.
 */
export async function IncidentDetailMock({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return id === incidents[0].id ? <IncidentsMock /> : <IncidentNotFound />;
}
