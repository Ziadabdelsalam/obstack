import { Suspense } from "react";
import { DIFF_PICKER_SIZE, TraceDiffLive } from "@/components/trace/TraceDiffLive";
import { TraceDiffMock } from "@/components/trace/TraceDiffMock";
import { dataForSession, dataMode } from "@/server/data";

/**
 * The diff, live-wired (D367/D400): a server component branching on `dataMode`.
 * The mock branch returns the moved client body with ZERO props BEFORE anything
 * request-shaped is awaited, so mock mode still prerenders the same static
 * page it does today; the live branch resolves both sides through the EXISTING
 * facade reads (no query module of its own — this surface asks for two traces
 * the workspace already has) and feeds `TraceDiffLive` nothing but data.
 *
 * No `connection()` here, unlike `traces/[id]/page.tsx`: reading `searchParams`
 * is itself a request-time API and "will opt the page into dynamic rendering at
 * request time" (Next 16 `page.js` file-convention reference — the same
 * argument `traces/page.tsx:7-10` makes), so live rows cannot be baked into a
 * prerender (D27a).
 *
 * `?a=` absent means "nothing picked yet", not "not found": it resolves to the
 * most recent trace so the surface opens on something real, which is also what
 * keeps `TraceDiffLive`'s "trace not found in this workspace" true wherever it
 * renders. An id that IS named and misses — unknown, or another workspace's,
 * which the scoped read cannot see (D113) — resolves to null and says so.
 *
 * D416: that auto-pick is silent about being one unless we say so — `aAutoPicked`
 * is true exactly when `?a=` was absent (the same falsy check the fallback
 * below already runs), and `TraceDiffLive` captions slot A with it only then.
 */
export default async function TraceDiffPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  if (dataMode !== "live")
    return (
      <Suspense>
        <TraceDiffMock />
      </Suspense>
    );

  const params = await searchParams;
  const aId = typeof params.a === "string" ? params.a : "";
  const bId = typeof params.b === "string" ? params.b : "";
  // D416: the same falsy check that drives the recent[0] fallback just below —
  // whenever that fallback fires, slot A must caption itself as auto-picked.
  const aAutoPicked = !aId;

  const data = await dataForSession();
  // Three independent reads, in parallel: the two sides and the picker's rows.
  const [aTrace, bTrace, search] = await Promise.all([
    aId ? data.getTrace(aId) : undefined,
    bId ? data.getTrace(bId) : undefined,
    data.searchTraces({}),
  ]);
  const recent = search.traces.slice(0, DIFF_PICKER_SIZE);

  return (
    <TraceDiffLive
      a={aId ? aTrace ?? null : recent[0] ?? null}
      b={bId ? bTrace ?? null : null}
      recent={recent}
      aAutoPicked={aAutoPicked}
    />
  );
}
