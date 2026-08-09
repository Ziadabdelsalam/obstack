"use client";

import { useState } from "react";
import Link from "next/link";
import { Bell, BellRing, Workflow, Users, Info, X } from "lucide-react";
import { notifications } from "@/mock/inbox";

const kindIcon = { alert: BellRing, pipeline: Workflow, team: Users, system: Info } as const;
const kindColor = {
  alert: "var(--color-warn)",
  pipeline: "var(--color-api)",
  team: "var(--color-agent)",
  system: "var(--color-mid)",
} as const;

export function NotificationsBell() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState(notifications);
  const unread = items.filter((n) => n.unread).length;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-[6px] text-[13px] text-mid transition-colors hover:bg-raised hover:text-ink"
      >
        <Bell className="h-4 w-4" />
        Notifications
        {unread > 0 && (
          <span
            className="ml-auto rounded-full px-1.5 font-mono text-[10px] leading-4"
            style={{
              color: "var(--color-warn)",
              background: "color-mix(in srgb, var(--color-warn) 14%, transparent)",
            }}
          >
            {unread}
          </span>
        )}
      </button>

      {open && (
        <div className="fixed inset-0 z-50 bg-black/40" onClick={() => setOpen(false)} role="dialog" aria-modal="true" aria-label="Notifications">
          <div
            className="absolute top-0 left-[216px] flex h-full w-[360px] flex-col border-r border-line-strong bg-surface shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-line px-4 py-3">
              <h2 className="text-[14px] font-medium text-ink">Notifications</h2>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setItems((xs) => xs.map((x) => ({ ...x, unread: false })))}
                  className="font-mono text-[10.5px] text-faint hover:text-ink"
                >
                  mark all read
                </button>
                <button type="button" onClick={() => setOpen(false)} aria-label="Close" className="rounded p-1 text-faint hover:bg-overlay hover:text-ink">
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto">
              {items.map((n) => {
                const Icon = kindIcon[n.kind];
                return (
                  <Link
                    key={n.id}
                    href={n.href}
                    onClick={() => setOpen(false)}
                    className="flex items-start gap-3 border-b border-line/50 px-4 py-3 hover:bg-raised"
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
        </div>
      )}
    </>
  );
}
