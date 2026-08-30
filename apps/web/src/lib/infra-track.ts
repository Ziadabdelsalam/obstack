import type { K8sEvent } from "@/lib/types";

/**
 * The heading over the trace waterfall's infra track (F2 amendment).
 *
 * It read "infra · pods & k8s events" unconditionally, on every trace, for
 * every deployment. Nothing produces the second half: `server/adapters.ts`
 * leaves `k8sEvents` undefined by construction, so in a real workspace the
 * clause is always false — and it is false in the demo too on any story that
 * carries no events, which includes the pipeline trace the landing page uses as
 * its screenshot. A header naming a data type the timeline below it does not
 * contain is a capability claim, and D208's line is that demo DATA is allowed
 * where a false capability claim is not.
 *
 * So the clause is earned per render: it appears when at least one track
 * actually holds an event and not otherwise. Pure and client-safe on purpose —
 * `Waterfall` is a `"use client"` component and the test runner is pinned to
 * `--conditions react-server`, which cannot import one (D54(ii)), so the
 * decision lives here where both branches can be executed by a test.
 */
export function infraTrackHeading(tracks: readonly { events: readonly K8sEvent[] }[]): string {
  return tracks.some((t) => t.events.length > 0) ? "infra · pods & k8s events" : "infra · pods";
}
