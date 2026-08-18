import { connection } from "next/server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { SideNav } from "@/components/shell/SideNav";
import { TopBar } from "@/components/shell/TopBar";
import { CommandPalette } from "@/components/shell/CommandPalette";
import { UsageBanner } from "@/components/shell/UsageBanner";
import { SampleDataBadge } from "@/components/shell/SampleDataBadge";
import { TourGuide } from "@/components/shell/TourGuide";
import { FloatingAsk } from "@/components/ask/FloatingAsk";
import { WorkspaceProvider } from "@/state/workspace-store";
import { dataMode } from "@/server/data";
import { getAuth } from "@/server/auth";
import { getSessionContext } from "@/server/session";

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
  return (
    <WorkspaceProvider>
      <div className="flex h-screen overflow-hidden">
        <SideNav workspaceId={session?.workspaceId ?? null} />
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar live={live} account={account} />
          {/* free-tier quota is mock billing state until M3 owns metering (F7) */}
          {!live && <UsageBanner />}
          {live && <SampleDataBadge />}
          <main className="min-w-0 flex-1 overflow-x-hidden overflow-y-auto">{children}</main>
        </div>
        <CommandPalette />
        <TourGuide />
        <FloatingAsk />
      </div>
    </WorkspaceProvider>
  );
}
