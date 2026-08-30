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
 * The one row definition for both modes. The last two rows are `false` and stay
 * `false` — no flag reaches them, so no input can tick them, and a tick beside
 * them would be the same lie the first three just stopped telling.
 *
 * S4.4 R2 should-fix 3: those two rows used to read "Create an SLO"
 * (`/app/slos`) and "Route alerts to Slack" (`/app/alerts`). Both are M5
 * surfaces that render sample content, and Slack is not in the connector
 * catalog at all — so the product's own setup checklist was telling a new
 * workspace to go and do two things it cannot do, on the dashboard the landing
 * page ships as a screenshot. D211 took the false ticks off the first three
 * rows; this takes the false ERRANDS off the last two. What replaces them is
 * shipped and live-wired (`lib/live-routes.ts`): the Explain run on a trace and
 * the logs explorer.
 *
 * Neither replacement can be derived from the three flags, deliberately. "Issue
 * an API key" would have been the obvious fourth row and is the wrong one: a
 * source can only have connected on a key this workspace already issued, so an
 * unticked key row beside a ticked `sourceConnected` would be a fresh
 * contradiction in the place the last one was just removed from.
 */
export function checklistSteps(flags: ChecklistFlags) {
  return [
    { label: "Connect a source", done: flags.sourceConnected, href: "/app/connections" },
    { label: "See your first trace", done: flags.firstTrace, href: "/app/traces" },
    { label: "Invite your team", done: flags.teamInvited, href: "/app/settings" },
    { label: "Explain a trace", done: false, href: "/app/traces" },
    { label: "Search your logs", done: false, href: "/app/logs" },
  ];
}

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
