"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  LayoutGrid,
  Share2,
  Boxes,
  ListTree,
  Telescope,
  ScrollText,
  Workflow,
  Bug,
  BellRing,
  PhoneCall,
  Siren,
  Target,
  Plug,
  Bot,
  CircleDollarSign,
  Users,
  History,
  Server,
  BookOpen,
  ShieldCheck,
  MessagesSquare,
  FlaskConical,
  Rocket,
  Settings,
  Command,
} from "lucide-react";
import { Wordmark } from "./Wordmark";
import type { WorkspaceChoiceView } from "@/lib/workspace-types";
import { switchWorkspace } from "@/app/app/workspace-actions";

const sections: {
  label: string | null;
  items: { href: string; label: string; icon: typeof LayoutDashboard; exact?: boolean }[];
}[] = [
  {
    label: null,
    items: [
      { href: "/app", label: "Overview", icon: LayoutDashboard, exact: true },
      { href: "/app/dashboards", label: "Dashboards", icon: LayoutGrid },
      { href: "/app/map", label: "Map", icon: Share2 },
      { href: "/app/services", label: "Services", icon: Boxes },
      { href: "/app/traces", label: "Traces", icon: ListTree },
      { href: "/app/explore", label: "Explore", icon: Telescope },
      { href: "/app/logs", label: "Logs", icon: ScrollText },
      { href: "/app/issues", label: "Issues", icon: Bug },
      { href: "/app/pipelines", label: "Pipelines", icon: Workflow },
      { href: "/app/alerts", label: "Alerts", icon: BellRing },
      { href: "/app/oncall", label: "On-call", icon: PhoneCall },
      { href: "/app/incidents", label: "Incidents", icon: Siren },
      { href: "/app/changes", label: "Changes", icon: History },
      { href: "/app/infra", label: "Infrastructure", icon: Server },
      { href: "/app/docs", label: "Docs", icon: BookOpen },
      { href: "/app/security", label: "Security", icon: ShieldCheck },
      { href: "/app/slos", label: "SLOs", icon: Target },
      { href: "/app/costs", label: "Costs", icon: CircleDollarSign },
      { href: "/app/users", label: "Users", icon: Users },
      { href: "/app/connections", label: "Connections", icon: Plug },
      { href: "/app/mcp", label: "MCP server", icon: Bot },
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

/**
 * `workspaceId` is the facade's live workspace, or null in mock mode where the
 * whole org is demo content. `choices` are the workspaces the signed-in person
 * may read (D717) — one per organization they belong to, empty in mock mode —
 * and the switcher renders only when there is more than one, because a control
 * with one option is an affordance with nothing behind it (D228's argument,
 * which still decides the single-workspace case).
 */
export function SideNav({
  workspaceId,
  choices,
}: {
  workspaceId: string | null;
  choices: WorkspaceChoiceView[];
}) {
  const pathname = usePathname();
  return (
    <aside className="flex h-screen w-[216px] shrink-0 flex-col overflow-y-auto border-r border-line bg-surface">
      <div className="flex items-center px-4 pt-4 pb-3">
        <Link href="/" aria-label="obstack home">
          <Wordmark />
        </Link>
      </div>

      {/* The label first, exactly as D228 shaped it — the id the drive reads
          (D115) stays in its own element, inside no button — and the switcher
          UNDER it (D717): a real form posting a real choice to the store, shown
          only when the person has somewhere else to go. */}
      <div className="mx-3 mb-3 flex flex-col rounded-md border border-line bg-raised px-2.5 py-1.5 text-left text-[12.5px] leading-tight text-ink">
        {/* Live mode names no organisation: signup gives an org the operator's
            own name as a stand-in (there is no org-name field), so rendering
            it here would put a person where an org belongs. The workspace
            below is the real thing this shell reads. */}
        <span className="font-medium">{workspaceId ? "Workspace" : "Loopwork"}</span>
        {/* The workspace id, verbatim and alone in its element: this is the
            line that tells an operator which tenant they are reading, and the
            e2e drive reads the same text to learn it (D115). */}
        <span
          data-workspace-id={workspaceId ?? undefined}
          className="font-mono text-[10px] text-faint"
        >
          {workspaceId ?? "loopwork-prod"}
        </span>
      </div>
      {choices.length > 1 && (
        <form action={switchWorkspace} className="mx-3 mb-3 flex items-center gap-1.5">
          {/* The selected option IS the active organization: its name (the
              owner's own, at signup) and the person's role there. Changing it
              submits; the button is the same submit for a browser with no
              JavaScript. */}
          <select
            name="workspaceId"
            aria-label="Switch workspace"
            defaultValue={workspaceId ?? undefined}
            onChange={(e) => e.currentTarget.form?.requestSubmit()}
            className="min-w-0 flex-1 rounded-md border border-line bg-raised px-2 py-1 text-[12px] text-mid focus:border-line-strong focus:outline-none"
          >
            {choices.map((choice) => (
              <option key={choice.workspaceId} value={choice.workspaceId}>
                {choice.orgName} · {choice.role}
              </option>
            ))}
          </select>
          <button
            type="submit"
            className="rounded-md border border-line bg-raised px-2 py-1 font-mono text-[10px] text-faint hover:text-ink"
          >
            switch
          </button>
        </form>
      )}

      {sections.map((sec, si) => (
        <nav key={si} className="flex flex-col gap-px px-2 pb-1.5">
          {sec.label && (
            <p className="px-2.5 pt-1.5 pb-1 font-mono text-[9.5px] uppercase tracking-widest text-faint">
              {sec.label}
            </p>
          )}
          {sec.items.map(({ href, label, icon: Icon, exact }) => {
            const active = exact ? pathname === href : pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                className={`flex items-center gap-2.5 rounded-md px-2.5 py-[5px] text-[13px] transition-colors ${
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
        <div className="rounded-md border border-line bg-raised px-3 py-2.5">
          {/* The heading was "demo workspace" in both modes, which reads as a
              claim about the tenant — false for an operator looking at their
              own live workspace, where only the unwired surfaces are demo. */}
          <p className="font-mono text-[10px] uppercase tracking-widest text-faint">
            {workspaceId ? "unwired surfaces" : "demo workspace"}
          </p>
          {/* in live mode the wired surfaces are real telemetry — only the rest is demo content */}
          <p className="mt-1 text-[12px] leading-snug text-mid">
            {workspaceId
              ? "Unwired surfaces show sample data."
              : "Sample data from a fictional AI support-agent company."}
          </p>
        </div>
      </div>
    </aside>
  );
}
