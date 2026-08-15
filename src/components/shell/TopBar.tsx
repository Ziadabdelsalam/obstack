"use client";

import { useState } from "react";
import Link from "next/link";
import {
  Search,
  ChevronDown,
  Settings,
  Rocket,
  BookOpen,
  ScrollText,
  LogOut,
} from "lucide-react";
import { NotificationsBell } from "./NotificationsPanel";
import { StartTourButton } from "./TourGuide";
import { SampleMark } from "@/components/ui/SampleMark";

function AccountMenu({ live }: { live: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Account menu"
        className="flex items-center gap-1.5 rounded-md p-1 pl-1.5 transition-colors hover:bg-raised"
      >
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-overlay font-mono text-[10px] text-mid">
          ZA
        </span>
        <ChevronDown className="h-3 w-3 text-faint" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute top-full right-0 z-50 mt-1.5 w-[240px] overflow-hidden rounded-xl border border-line-strong bg-surface py-1 shadow-2xl">
            <div className="border-b border-line px-3.5 py-2.5">
              {/* there is no signed-in operator until M3 auth; the demo identity says so rather than being replaced by an invented one */}
              <p className="text-[13px] font-medium text-ink">
                Ziad Abdelsalam
                {live && (
                  <>
                    {" "}
                    <SampleMark title="demo account — real identities arrive with workspace auth" />
                  </>
                )}
              </p>
              <p className="font-mono text-[10.5px] text-faint">ziad@loopwork.ai · owner</p>
            </div>
            {[
              { label: "Settings", icon: Settings, href: "/app/settings" },
              { label: "Quickstart", icon: Rocket, href: "/app/onboarding" },
              { label: "Docs", icon: BookOpen, href: "#" },
              { label: "Changelog", icon: ScrollText, href: "/changelog" },
            ].map(({ label, icon: Icon, href }) => (
              <Link
                key={label}
                href={href}
                onClick={() => setOpen(false)}
                className="flex items-center gap-2.5 px-3.5 py-2 text-[12.5px] text-mid hover:bg-raised hover:text-ink"
              >
                <Icon className="h-3.5 w-3.5 text-faint" />
                {label}
              </Link>
            ))}
            <div className="mt-1 border-t border-line pt-1">
              <button
                type="button"
                title="Disabled in demo"
                className="flex w-full cursor-not-allowed items-center gap-2.5 px-3.5 py-2 text-[12.5px] text-mid opacity-70"
              >
                <LogOut className="h-3.5 w-3.5 text-faint" />
                Sign out
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * `live` gates the chrome's fabricated system claims (D21/F6/F7): throughput and
 * deployment region have no backing in live mode, and a marked lie would still
 * occupy the same bar, so they are simply absent — the real ingest state lives
 * on the overview, and the sample-data badge speaks for unwired routes.
 */
export function TopBar({ live }: { live: boolean }) {
  const openPalette = () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }));
  };

  return (
    <div className="flex h-11 shrink-0 items-center gap-3 border-b border-line bg-surface/60 px-4 backdrop-blur">
      {!live && (
        <>
          {/* live ingest status */}
          <span className="flex items-center gap-2 font-mono text-[11px] text-faint">
            <span className="pulse-dot inline-block h-1.5 w-1.5 rounded-full" style={{ background: "var(--color-ok)" }} />
            ingesting · 9.4k events/min
          </span>
          <span
            className="rounded-[3px] px-1.5 py-px font-mono text-[9.5px] tracking-wide"
            style={{
              color: "var(--color-infra)",
              background: "color-mix(in srgb, var(--color-infra) 10%, transparent)",
            }}
          >
            PROD · EU-CENTRAL
          </span>
        </>
      )}

      <div className="ml-auto flex items-center gap-1.5">
        <button
          type="button"
          onClick={openPalette}
          className="flex items-center gap-2 rounded-md border border-line bg-raised py-1 pr-1.5 pl-2.5 text-[12px] text-faint transition-colors hover:border-line-strong hover:text-mid"
        >
          <Search className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Jump to…</span>
          <kbd className="rounded border border-line bg-surface px-1 font-mono text-[9.5px]">⌘K</kbd>
        </button>
        <StartTourButton />
        <NotificationsBell live={live} />
        <span className="mx-1 h-4 w-px bg-line" />
        <AccountMenu live={live} />
      </div>
    </div>
  );
}
