"use client";

import { useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { Check, X, ArrowRight } from "lucide-react";

/**
 * What the first three rows are allowed to claim (D211). The dashboard server
 * component derives them; this module only renders them — a checklist that
 * decided its own answers is how it came to say "Connect a source ✓" to a
 * workspace that had never sent an event.
 */
export type ChecklistFlags = {
  /** something reached ingest on one of this workspace's keys */
  sourceConnected: boolean;
  /** and that data is queryable as a trace */
  firstTrace: boolean;
  /** the org has somebody in it besides its owner */
  teamInvited: boolean;
};

/** Mock mode's answers: the demo product has all three, as it always rendered. */
export const DEMO_CHECKLIST_FLAGS: ChecklistFlags = {
  sourceConnected: true,
  firstTrace: true,
  teamInvited: true,
};

/**
 * The one row definition for both modes: one row per flag, and NOTHING ELSE.
 * Every row here is derivable, so a workspace that has done the setup reads
 * `setup · 3/3` — the checklist can actually be finished.
 *
 * S4.4 R3 should-fix 3, which is the second half of a fix R2 started. R2
 * replaced two rows that pointed at unbuilt surfaces ("Create an SLO",
 * "Route alerts to Slack") with two that point at shipped, live-wired ones —
 * an Explain run and the logs explorer. True errands, but they stayed
 * hardcoded `done: false` with no flag able to reach them, so the counter read
 * `setup · 3/5` FOREVER on a live workspace that had done everything the
 * product can observe, and both rows rendered as checkboxes nothing can tick.
 * A permanent 3/5 is the same class of untruth as a false tick, pointing the
 * other way, and it is the reading that never goes away.
 *
 * WHY THEY ARE NOT WIRED INSTEAD. Both were checked against what this product
 * actually stores:
 *   - "used Explain" has one persisted signal, `explain_runs` (0006), keyed
 *     `(workspace_id, period_start)` per UTC calendar month and read by
 *     `getExplainQuota` — THE Explain-quota definition (D226). Ticking on
 *     `used > 0` would untick itself at every month rollover; asking a
 *     different question (has this workspace EVER run one) means a second
 *     definition of the same fact in a second place, plus another round trip on
 *     every dashboard render, to tick one row.
 *   - "searched logs" has no persisted signal at all. No table records a
 *     query; `saved_views` records a SAVED view, which is a different act — a
 *     workspace can search logs all week and save nothing.
 * So the honest shape is not a checkbox. They stay as `tryNext` below: two
 * links, no boxes, nothing claimed about whether they were done.
 *
 * "Issue an API key" would have been the obvious way to reach a fourth
 * derivable row and is still the wrong one: a source can only have connected on
 * a key this workspace already issued, so an unticked key row beside a ticked
 * `sourceConnected` would be a fresh contradiction in the place D211 removed
 * the last one from.
 */
export function checklistSteps(flags: ChecklistFlags) {
  return [
    { label: "Connect a source", done: flags.sourceConnected, href: "/app/connections" },
    { label: "See your first trace", done: flags.firstTrace, href: "/app/traces" },
    { label: "Invite your team", done: flags.teamInvited, href: "/app/settings" },
  ];
}

/**
 * Suggestions, not steps: shipped surfaces worth a first visit, rendered as
 * plain links with no checkbox and counted in no fraction.
 *
 * Both destinations are live-wired (`lib/live-routes.ts`) and DISTINCT — the
 * Explain row used to send the reader to `/app/traces`, the same place the
 * "See your first trace" row above already sends them, so the checklist's
 * fourth item was a second copy of its second item. Explain lives on a trace's
 * detail page and there is no trace id to link from here, so the link opens the
 * traces list already filtered to failures: the traces worth explaining, and
 * the same `?status=error` view the dashboard's own error cards link to.
 */
export const tryNext: readonly { label: string; href: string }[] = [
  { label: "Explain a failing trace", href: "/app/traces?status=error" },
  { label: "Search your logs", href: "/app/logs" },
];

const STORAGE_KEY = "obstack-checklist-dismissed";

// localStorage is an external store, read through the hook built for one
// (react-hooks/set-state-in-effect): the server snapshot says "dismissed", so
// the server renders null exactly as the old mount-effect shape did, and the
// client's first render reads the real flag with no effect and no flash.
const emptySubscribe = () => () => {};
function readDismissed(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function OnboardingChecklist({ flags }: { flags: ChecklistFlags }) {
  const steps = checklistSteps(flags);
  const storedDismissed = useSyncExternalStore(emptySubscribe, readDismissed, () => true);
  const [dismissedNow, setDismissedNow] = useState(false);

  if (storedDismissed || dismissedNow) return null;
  const done = steps.filter((s) => s.done).length;

  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border border-line bg-surface px-4 py-2.5">
      <span className="font-mono text-[10.5px] uppercase tracking-widest text-faint">
        setup · {done}/{steps.length}
      </span>
      <div className="flex flex-1 flex-wrap items-center gap-x-4 gap-y-1.5">
        {steps.map((s) => (
          <Link
            key={s.label}
            href={s.href}
            className="group flex items-center gap-1.5 text-[12px]"
            style={{ color: s.done ? "var(--color-faint)" : "var(--color-mid)" }}
          >
            {s.done ? (
              <Check className="h-3.5 w-3.5" style={{ color: "var(--color-ok)" }} />
            ) : (
              <span className="h-3 w-3 rounded-full border border-line-strong group-hover:border-faint" />
            )}
            <span className={s.done ? "line-through decoration-line" : "group-hover:text-ink"}>
              {s.label}
            </span>
            {!s.done && <ArrowRight className="h-3 w-3 opacity-0 transition-opacity group-hover:opacity-100" />}
          </Link>
        ))}
        {/* The seam: past this label nothing is a step, so nothing carries a
            box to leave unticked (see `tryNext`). */}
        <span className="font-mono text-[10.5px] uppercase tracking-widest text-faint">try next</span>
        {tryNext.map((s) => (
          <Link
            key={s.label}
            href={s.href}
            className="group flex items-center gap-1.5 text-[12px] text-mid hover:text-ink"
          >
            <span>{s.label}</span>
            <ArrowRight className="h-3 w-3 opacity-40 transition-opacity group-hover:opacity-100" />
          </Link>
        ))}
      </div>
      <button
        type="button"
        aria-label="Dismiss setup checklist"
        onClick={() => {
          setDismissedNow(true);
          try {
            localStorage.setItem(STORAGE_KEY, "1");
          } catch {}
        }}
        className="rounded p-1 text-faint hover:bg-overlay hover:text-ink"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
