import Link from "next/link";

/**
 * The ONE definition of the D436 sentence on the incidents surface (S7.4
 * packet D520/D546): an id this workspace does not hold is a rendered sentence,
 * not a 500, not a framework 404 (there is no `not-found.tsx`, and a demo
 * visitor would leave the app shell entirely), and never another tenant's row.
 * The words are the store's own `NO_SUCH_INCIDENT` (D440): an id that never
 * existed and an id another workspace holds get the same sentence, so the
 * page cannot be used to learn which of the two it was.
 *
 * Rendered by BOTH halves of the pair — the mock router `IncidentDetailMock`
 * for any id that is not the fixture's, and the live detail for any id the
 * workspace does not hold — so the sentence has one home and cannot drift
 * between modes. The pair (the sentence, then `← back to …`) is
 * `DashboardDetailLive`'s, copied with the noun changed and nothing else.
 *
 * A server component with no props: it reads nothing and says one thing.
 */
export function IncidentNotFound() {
  return (
    <div className="px-5 py-4">
      <div className="rounded-lg border border-line bg-surface p-6 text-center">
        <p className="font-mono text-[13px] text-mid">no incident with this id in your workspace</p>
        <Link
          href="/app/incidents"
          className="mt-3 inline-block font-mono text-[12px] text-faint hover:text-ink"
        >
          ← back to incidents
        </Link>
      </div>
    </div>
  );
}
