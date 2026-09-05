"use client";

import { useState } from "react";
import type { Explanation } from "@/lib/types";
import { IncidentRcaPanel, usedAfter } from "./IncidentRcaPanel";

/**
 * The client rail that OWNS the RCA's page state (S7.4 T6, D582 — the seventh
 * component, recorded as a plan correction: D546 counts six, but
 * `IncidentRcaPanel`'s contract needs a CLIENT parent).
 *
 * `IncidentRcaPanel` (T5) takes `prepared` — the answer a run on this page
 * already produced, rendered instead of re-run because the RCA is not stored
 * (D555) — and `onFinished(run)`, the callback that hands the page the answer
 * and the spend. `IncidentDetailLive` is a SERVER component, and a server
 * component can neither hold that state nor pass a function across the
 * boundary, so the panel would have had to be mounted with a no-op and the
 * answer would have died with the first re-render. This file is that parent
 * and nothing more: two pieces of state and one callback.
 *
 * The counter is `max(used, usedAtMount + spent)` ⟨S7.4 T6 review, D588:
 * as first written it was `used + spent`, which double-counts after a
 * `router.refresh()` — a resolve or edit from `IncidentControls` on this
 * same page re-renders the server half with `used` already holding this
 * page's runs while `spent` survives as client state, so the D226 line read
 * one too many⟩. `used` is the server's number on THIS render and a refresh
 * flows the fresh count through; `usedAtMount + spent` is what this page
 * knows on its own before that refresh lands, `usedAfter` deciding whether a
 * run counted (a refusal and an unreachable route moved nothing, D225/D240).
 * The larger of the two is never a fabrication: each is a count the product
 * observed. No quota literal lives here (D226): both numbers arrive from the
 * plan row through the page.
 *
 * Imports nothing from `@/server/*` and nothing from `@/mock/*`.
 */
export function IncidentRcaRail({
  incidentId,
  used,
  quota,
  canRunRca,
}: {
  incidentId: string;
  /** The plan's Explain month as the server rendered it, before this page ran anything. */
  used: number;
  quota: number;
  /** False when the stitched timeline holds no read row inside the window (D558). */
  canRunRca: boolean;
}) {
  const [prepared, setPrepared] = useState<Explanation | undefined>(undefined);
  const [spent, setSpent] = useState(0);
  const [usedAtMount] = useState(used);

  return (
    <IncidentRcaPanel
      incidentId={incidentId}
      prepared={prepared}
      used={Math.max(used, usedAtMount + spent)}
      quota={quota}
      canRunRca={canRunRca}
      onFinished={(run) => {
        setSpent((n) => usedAfter(n, run));
        if (run.phase === "answered") setPrepared(run.explanation);
      }}
    />
  );
}
