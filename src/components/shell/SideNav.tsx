"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  ListTree,
  ScrollText,
  BellRing,
  Plug,
  MessagesSquare,
  FlaskConical,
  Rocket,
  Settings,
  ChevronsUpDown,
  Command,
} from "lucide-react";
import { Wordmark } from "./Wordmark";

const sections: {
  label: string | null;
  items: { href: string; label: string; icon: typeof LayoutDashboard; exact?: boolean }[];
}[] = [
  {
    label: null,
    items: [
      { href: "/app", label: "Overview", icon: LayoutDashboard, exact: true },
      { href: "/app/traces", label: "Traces", icon: ListTree },
      { href: "/app/logs", label: "Logs", icon: ScrollText },
      { href: "/app/alerts", label: "Alerts", icon: BellRing },
      { href: "/app/connections", label: "Connections", icon: Plug },
    ],
  },
  {
    label: "ai assist",
    items: [
      { href: "/app/ask", label: "Ask", icon: MessagesSquare },
      { href: "/app/evals", label: "Evals", icon: FlaskConical },
    ],
  },
  {
    label: "workspace",
    items: [
      { href: "/app/onboarding", label: "Quickstart", icon: Rocket },
      { href: "/app/settings", label: "Settings", icon: Settings },
    ],
  },
];

export function SideNav() {
  const pathname = usePathname();
  return (
    <aside className="flex h-screen w-[216px] shrink-0 flex-col overflow-y-auto border-r border-line bg-surface">
      <div className="flex items-center px-4 pt-4 pb-3">
        <Link href="/" aria-label="obstack home">
          <Wordmark />
        </Link>
      </div>

      <button
        type="button"
        className="mx-3 mb-3 flex items-center justify-between rounded-md border border-line bg-raised px-2.5 py-1.5 text-left text-[12.5px] text-ink hover:border-line-strong"
      >
        <span className="flex flex-col leading-tight">
          <span className="font-medium">Loopwork</span>
          <span className="font-mono text-[10px] text-faint">loopwork-prod</span>
        </span>
        <ChevronsUpDown className="h-3.5 w-3.5 text-faint" />
      </button>

      {sections.map((sec, si) => (
        <nav key={si} className="flex flex-col gap-px px-2 pb-2">
          {sec.label && (
            <p className="px-2.5 pt-2 pb-1 font-mono text-[9.5px] uppercase tracking-widest text-faint">
              {sec.label}
            </p>
          )}
          {sec.items.map(({ href, label, icon: Icon, exact }) => {
            const active = exact ? pathname === href : pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                className={`flex items-center gap-2.5 rounded-md px-2.5 py-[6px] text-[13px] transition-colors ${
                  active
                    ? "bg-overlay text-ink"
                    : "text-mid hover:bg-raised hover:text-ink"
                }`}
              >
                <Icon
                  className="h-4 w-4"
                  style={active ? { color: "var(--color-api)" } : undefined}
                />
                {label}
              </Link>
            );
          })}
        </nav>
      ))}

      <div className="mt-auto px-4 pb-4">
        <p className="mb-3 flex items-center gap-1.5 font-mono text-[10px] text-faint">
          <Command className="h-3 w-3" />K to jump anywhere
        </p>
        <div className="mb-3 rounded-md border border-line bg-raised px-3 py-2.5">
          <p className="font-mono text-[10px] uppercase tracking-widest text-faint">
            demo workspace
          </p>
          <p className="mt-1 text-[12px] leading-snug text-mid">
            Sample data from a fictional AI support-agent company.
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-overlay font-mono text-[10px] text-mid">
            ZA
          </span>
          <span className="text-[12px] text-mid">ziad@loopwork.ai</span>
        </div>
      </div>
    </aside>
  );
}
