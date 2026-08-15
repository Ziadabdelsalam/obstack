"use client";

import { useState } from "react";
import Link from "next/link";
import { Bell, BellRing, Workflow, Users, Info } from "lucide-react";
import { notifications } from "@/mock/inbox";
import { SampleMark } from "@/components/ui/SampleMark";

const kindIcon = { alert: BellRing, pipeline: Workflow, team: Users, system: Info } as const;
const kindColor = {
  alert: "var(--color-warn)",
  pipeline: "var(--color-api)",
  team: "var(--color-agent)",
  system: "var(--color-mid)",
} as const;

/**
 * Bell with unread badge + right-anchored dropdown, for the top bar.
 *
 * In live mode the count is gated out rather than marked (D21/F6/F7): a badge
 * reading "3" is a numeric claim about the operator's real inbox, and no marker
 * fits on it — the panel it opens carries the SAMPLE marker instead.
 */
export function NotificationsBell({ live }: { live: boolean }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState(notifications);
  const unread = live ? 0 : items.filter((n) => n.unread).length;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={`Notifications${unread ? ` (${unread} unread)` : ""}`}
        className="relative rounded-md p-1.5 text-mid transition-colors hover:bg-raised hover:text-ink"
      >
        <Bell className="h-4 w-4" />
        {unread > 0 && (
          <span
            className="absolute top-0.5 right-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full px-0.5 font-mono text-[8.5px] leading-none font-semibold text-bg"
            style={{ background: "var(--color-warn)" }}
          >
            {unread}
          </span>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute top-full right-0 z-50 mt-1.5 w-[380px] overflow-hidden rounded-xl border border-line-strong bg-surface shadow-2xl">
            <div className="flex items-center justify-between border-b border-line px-3.5 py-2.5">
              <h2 className="text-[13px] font-medium text-ink">
                Notifications
                {live && (
                  <>
                    {" "}
                    <SampleMark title="demo inbox — real alerts and pipeline events arrive as those surfaces are wired" />
                  </>
                )}
              </h2>
              <button
                type="button"
                onClick={() => setItems((xs) => xs.map((x) => ({ ...x, unread: false })))}
                className="font-mono text-[10.5px] text-faint hover:text-ink"
              >
                mark all read
              </button>
            </div>
            <div className="max-h-[420px] overflow-y-auto">
              {items.map((n) => {
                const Icon = kindIcon[n.kind];
                return (
                  <Link
                    key={n.id}
                    href={n.href}
                    onClick={() => setOpen(false)}
                    className="flex items-start gap-3 border-b border-line/50 px-3.5 py-2.5 last:border-0 hover:bg-raised"
                  >
                    <span
                      className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md"
                      style={{ background: `color-mix(in srgb, ${kindColor[n.kind]} 12%, transparent)` }}
                    >
                      <Icon className="h-3.5 w-3.5" style={{ color: kindColor[n.kind] }} />
                    </span>
                    <span className="min-w-0">
                      <span className={`block text-[12.5px] leading-snug ${n.unread ? "text-ink" : "text-mid"}`}>
                        {n.title}
                      </span>
                      <span className="mt-0.5 block font-mono text-[10px] text-faint">{n.time}</span>
                    </span>
                    {n.unread && (
                      <span className="mt-1.5 ml-auto h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: "var(--color-api)" }} />
                    )}
                  </Link>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
