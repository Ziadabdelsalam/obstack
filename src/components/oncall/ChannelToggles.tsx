"use client";

import { Hash, Mail, Siren, Webhook } from "lucide-react";
import { useWorkspace } from "@/state/workspace-store";
import type { NotificationChannel } from "@/mock/oncall";

const kindIcon: Record<NotificationChannel["kind"], typeof Hash> = {
  slack: Hash,
  pagerduty: Siren,
  email: Mail,
  webhook: Webhook,
};

export function ChannelToggles() {
  const { channels, toggleChannel } = useWorkspace();

  return (
    <div className="space-y-1.5">
      {channels.map((c) => {
        const Icon = kindIcon[c.kind];
        return (
          <div
            key={c.id}
            className="flex items-center gap-3 rounded-md border border-line bg-raised px-2.5 py-2"
          >
            <Icon className="h-3.5 w-3.5 shrink-0 text-faint" />
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] text-ink">{c.name}</span>
              <span className="block font-mono text-[10.5px] text-faint">{c.target}</span>
            </span>
            <button
              type="button"
              onClick={() => toggleChannel(c.id)}
              aria-pressed={c.enabled}
              aria-label={`Toggle ${c.name}`}
              className={`h-[18px] w-8 shrink-0 rounded-full p-px transition-colors ${c.enabled ? "" : "bg-raised"}`}
              style={c.enabled ? { background: "var(--color-ok)" } : undefined}
            >
              <span
                className="block h-[16px] w-[16px] rounded-full bg-ink transition-transform"
                style={{ transform: c.enabled ? "translateX(14px)" : "none" }}
              />
            </button>
          </div>
        );
      })}
    </div>
  );
}
