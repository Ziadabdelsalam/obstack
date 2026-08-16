/**
 * The URL-echo reconciliation both filter bars run (D72).
 *
 * A filter bar and the URL move in two directions at once: the bar navigates
 * when the user edits, and the server renders a URL back at it. The bar must
 * adopt a URL it did NOT produce — back/forward, a deep link, a saved view
 * applied — and must NOT adopt its own navigation coming back, because the
 * user usually types on while it is in flight and adopting the echo rewinds
 * their text.
 *
 * The two bars wrote that rule twice, the same day, from the same plan, and
 * they diverged: `/app/logs` remembered ONE pushed URL, so two edits in flight
 * meant the first echo looked external and rewound the second edit — typing
 * "abc" fast enough lost the "c". That is why this is a module and not a
 * comment (D72(ii)/(iii)).
 *
 * Two exports, and the split is the point:
 *
 * - `syncUrl`/`pushedUrl` are the PURE decision core — a pending-push LIST and
 *   an incoming URL in, adopt-or-ignore and the pruned list out. Pure means the
 *   pinned test runner can drive every case, which neither bar's inline wiring
 *   ever allowed (D54(ii): `--conditions react-server` cannot import a real
 *   component module).
 * - `useFilterUrlSync` is a thin wrapper holding the state, the 250 ms debounce
 *   and the navigation call. It is kept thin precisely so that everything it
 *   wraps is the tested core; its own coverage of record is T5's browser run
 *   (D72, D54(iii) authority).
 *
 * The wrapper takes the navigation as a callback rather than calling
 * `useRouter` here, and that is load-bearing rather than stylistic: importing
 * `next/navigation` in this module would pull `app-router-context` into it, and
 * that module calls `React.createContext`, which does not exist in the
 * react-server React build the test runner is pinned to — the core would stop
 * being unit-testable, which is the whole reason it was extracted. The bars
 * already hold a router; they hand over one stable callback.
 *
 * No `"use client"` directive: this module is imported BY the bars, which
 * carry the directive, and a directive here would make it a client entry point
 * of its own.
 */

import { useEffect, useState } from "react";

/**
 * What a bar remembers about the URL so it can tell its own navigation from one
 * that happened underneath it (carry-forward 2).
 */
export interface UrlSync {
  /** the query string the bar last received from the server */
  seen: string;
  /** query strings the bar navigated to whose server render has not come back yet */
  pending: readonly string[];
}

/** Bookkeeping for a navigation the bar itself just started. */
export function pushedUrl(sync: UrlSync, search: string): UrlSync {
  return { seen: sync.seen, pending: [...sync.pending, search] };
}

/**
 * Carry-forward 2, the whole rule in one place: what to do with the query
 * string the server just rendered.
 *
 * A URL the bar did not produce is ADOPTED: the inputs take its values, or they
 * keep their mount-time values forever, which is the bug this replaces. The
 * bar's own navigation coming back is not adopted; the echo is consumed from
 * `pending`, so the same URL reached again later is external. `pending` is a
 * LIST because more than one navigation can be in flight, and each echo must be
 * consumed by ITSELF — a late echo of an earlier edit is not evidence about the
 * later one. Adopting clears `pending` outright: the bar has been moved
 * somewhere else, so an echo still in flight for the URL it left is no longer
 * about its state.
 */
export function syncUrl(sync: UrlSync, incoming: string): { adopt: boolean; sync: UrlSync } {
  if (incoming === sync.seen) return { adopt: false, sync };
  const echo = sync.pending.indexOf(incoming);
  if (echo >= 0) {
    return {
      adopt: false,
      sync: { seen: incoming, pending: sync.pending.filter((_, i) => i !== echo) },
    };
  }
  return { adopt: true, sync: { seen: incoming, pending: [] } };
}

/**
 * The debounce that coalesces a typed word into one navigation, and so into one
 * server query. M1 behaviour on both surfaces, not re-litigated here.
 */
export const URL_SYNC_DEBOUNCE_MS = 250;

/**
 * Both directions of one filter bar's URL flow.
 *
 * `urlSearch` is the query string the server rendered (serialized from the
 * props it passed down); `editedSearch` is the one the controls currently hold.
 * When they differ because the URL moved, the core decides whether this is an
 * echo or someone else's navigation and `onAdopt` runs for the latter. When
 * they differ because the user edited, the edit is debounced into `navigate`.
 *
 * `navigate` must be stable across renders (a `useCallback` over the router),
 * because a new identity restarts the debounce timer.
 */
export function useFilterUrlSync({
  urlSearch,
  editedSearch,
  navigate,
  onAdopt,
}: {
  urlSearch: string;
  editedSearch: string;
  navigate: (search: string) => void;
  onAdopt: () => void;
}): void {
  const [sync, setSync] = useState<UrlSync>({ seen: urlSearch, pending: [] });

  // Adjusting state during render — React's own pattern for state derived from
  // a prop that changed. The URL is the prop, and the core decides.
  if (urlSearch !== sync.seen) {
    const next = syncUrl(sync, urlSearch);
    setSync(next.sync);
    if (next.adopt) onAdopt();
  }

  const settled = editedSearch === sync.seen || sync.pending.includes(editedSearch);

  useEffect(() => {
    if (settled) return;
    const timer = setTimeout(() => {
      setSync((s) => pushedUrl(s, editedSearch));
      navigate(editedSearch);
    }, URL_SYNC_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [settled, editedSearch, navigate]);
}
