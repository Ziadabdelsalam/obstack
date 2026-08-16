import { SideNav } from "@/components/shell/SideNav";
import { TopBar } from "@/components/shell/TopBar";
import { CommandPalette } from "@/components/shell/CommandPalette";
import { UsageBanner } from "@/components/shell/UsageBanner";
import { SampleDataBadge } from "@/components/shell/SampleDataBadge";
import { TourGuide } from "@/components/shell/TourGuide";
import { FloatingAsk } from "@/components/ask/FloatingAsk";
import { WorkspaceProvider } from "@/state/workspace-store";
import { dataMode, workspaceId } from "@/server/data";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const live = dataMode === "live";
  return (
    <WorkspaceProvider>
      <div className="flex h-screen overflow-hidden">
        <SideNav workspaceId={live ? workspaceId : null} />
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar live={live} />
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
