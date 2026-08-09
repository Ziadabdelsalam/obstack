"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Check, X, ArrowRight } from "lucide-react";

const steps = [
  { label: "Connect a source", done: true, href: "/app/connections" },
  { label: "See your first trace", done: true, href: "/app/traces" },
  { label: "Invite your team", done: true, href: "/app/settings" },
  { label: "Create an SLO", done: false, href: "/app/slos" },
  { label: "Route alerts to Slack", done: false, href: "/app/alerts" },
];

const STORAGE_KEY = "obstack-checklist-dismissed";

export function OnboardingChecklist() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    try {
      setVisible(localStorage.getItem(STORAGE_KEY) !== "1");
    } catch {
      setVisible(true);
    }
  }, []);

  if (!visible) return null;
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
          setVisible(false);
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
