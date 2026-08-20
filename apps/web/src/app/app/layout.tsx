import { connection } from "next/server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { SideNav } from "@/components/shell/SideNav";
import { TopBar } from "@/components/shell/TopBar";
import { CommandPalette } from "@/components/shell/CommandPalette";
import { UsageBanner, type UsageBannerProps } from "@/components/shell/UsageBanner";
import { SampleDataBadge } from "@/components/shell/SampleDataBadge";
import { TourGuide } from "@/components/shell/TourGuide";
import { FloatingAsk } from "@/components/ask/FloatingAsk";
import { WorkspaceProvider } from "@/state/workspace-store";
import { usage as mockUsage } from "@/mock/workspace";
import { dataMode } from "@/server/data";
import { getAuth } from "@/server/auth";
import { queryRows } from "@/server/postgres";
import { getSessionContext } from "@/server/session";
import { getUsage } from "@/server/usage";

/**
 * The demo's banner, which stays mock-fed (D125): mock mode has no ledger to
 * sum and no workspace to sum it for, so the numbers the demo has always shown
 * are handed to the same component the live shell uses.
 */
const MOCK_BANNER: UsageBannerProps = {
  planName: mockUsage.plan,
  eventsUsed: mockUsage.events.used,
  eventQuota: mockUsage.events.quota,
  resets: mockUsage.resetsOn,
};

/**
 * The period rolls over at the start of the month after the one being metered —
 * `periodStart` is the UTC month start (D163), so the reset is that month plus
 * one. Formatted here, in UTC, because the banner is a client component and a
 * date formatted there is formatted in two timezones across hydration.
 */
function resetsOn(periodStart: Date): string {
  const next = new Date(Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth() + 1, 1));
  return next.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * The live shell's banner numbers, from THE usage definition (D171) — the same
 * function the Billing & usage tab reads. Two SUMs would be the S2.3 L3
 * divergence class in its most visible form: a shell warning about a quota the
 * settings page says is fine.
 *
 * No catch: this runs after the guard below, on a path that has already read
 * Postgres twice for the session, so a database that cannot answer this query
 * has already taken the shell down — swallowing the error here would only buy a
 * banner-shaped hole in a page that is not going to render anyway.
 */
async function liveBanner(workspaceId: string): Promise<UsageBannerProps> {
  const usage = await getUsage(workspaceId, queryRows);
  return {
    planName: usage.planName,
    eventsUsed: usage.eventsUsed,
    eventQuota: usage.eventQuota,
    resets: resetsOn(usage.periodStart),
  };
}

/**
 * D134/D228: in mock mode — the public demo — nothing on screen said the
 * product was a demo. The sample-data badge is live-mode-only by construction
 * (it marks the unwired routes inside a real workspace), so a stranger could
 * read every screen of the demo without being told once that none of it
 * happened.
 *
 * A slim persistent bar in the shell, so every mock surface carries it and no
 * page has to remember to. Live mode never renders it: there the badge speaks
 * per route, and this sentence would be false about the wired ones.
 */
function DemoFooter() {
  return (
    <div
      className="flex shrink-0 items-center gap-2 border-t px-4 py-1.5"
      style={{
        borderColor: "color-mix(in srgb, var(--color-warn) 30%, var(--color-line))",
        background: "color-mix(in srgb, var(--color-warn) 6%, transparent)",
      }}
    >
      <span className="font-mono text-[11px] tracking-wide" style={{ color: "var(--color-warn)" }}>
        DEMO WORKSPACE
      </span>
      <span className="font-mono text-[11px] text-faint">
        every screen here is sample data from a fictional company — nothing is being ingested
      </span>
    </div>
  );
}

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const live = dataMode === "live";
  // The shell's workspace is the signed-in session's, resolved here once (D114).
  // Mock mode short-circuits on the mode check and never touches a session or
  // Postgres — the demo product runs with neither present, and every /app route
  // stays statically prerendered exactly as before.
  //
  // Live mode holds rendering for a real request first (D27a, the same hold
  // `/app` applies to live numbers): who is signed in is a per-request fact, so
  // a prerender of this shell would either bake one visitor's workspace into
  // the build or resolve a session at build time, where there is no request to
  // resolve one from.
  if (live) await connection();
  const session = live ? await getSessionContext() : null;
  // Tenancy and profile are two different questions. `getSessionContext`
  // answers "which workspace" and deliberately carries no name or email
  // (D114), so the one line of chrome that names a person reads the user
  // record beside it rather than a second copy of it living in the context.
  const user = session
    ? (await getAuth().api.getSession({ headers: await headers() }))?.user
    : null;
  // The live-mode guard (D114): no session, no shell — and no page below it
  // either. It has to be a redirect rather than a hidden tree, because a
  // layout does not control whether the rest of the route renders (Next's own
  // warning): every /app segment resolves its own session concurrently with
  // this one, and each of the wired ones throws `NoSessionError` when it finds
  // none. `redirect` aborts the WHOLE render with a 307, which is what wins
  // that race — measured on /app, /app/traces, /app/traces/[id] and /app/logs
  // against a production serve with no cookie (all four 500 without this line).
  //
  // A signed-in user whose session disappears between the two reads above is
  // the same verdict from this guard's side: signed out, so /login.
  if (live && !(session && user)) redirect("/login");
  const account =
    session && user
      ? { name: user.name, email: user.email, workspaceId: session.workspaceId }
      : null;
  const banner = session ? await liveBanner(session.workspaceId) : MOCK_BANNER;
  return (
    <WorkspaceProvider>
      <div className="flex h-screen overflow-hidden">
        <SideNav workspaceId={session?.workspaceId ?? null} />
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar live={live} account={account} />
          {/* Real Postgres usage rows in live mode, the demo's numbers in mock —
              the mode branch is above, and the banner itself takes props either
              way rather than knowing which product it is in. */}
          <UsageBanner {...banner} />
          {live && <SampleDataBadge />}
          <main className="min-w-0 flex-1 overflow-x-hidden overflow-y-auto">{children}</main>
          {!live && <DemoFooter />}
        </div>
        <CommandPalette live={live} />
        <TourGuide />
        <FloatingAsk />
      </div>
    </WorkspaceProvider>
  );
}
