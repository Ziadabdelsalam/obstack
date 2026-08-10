import { SideNav } from "@/components/shell/SideNav";
import { TopBar } from "@/components/shell/TopBar";
import { CommandPalette } from "@/components/shell/CommandPalette";
import { UsageBanner } from "@/components/shell/UsageBanner";
import { TourGuide } from "@/components/shell/TourGuide";
import { FloatingAsk } from "@/components/ask/FloatingAsk";
import { WorkspaceProvider } from "@/state/workspace-store";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <WorkspaceProvider>
      <div className="flex h-screen overflow-hidden">
        <SideNav />
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar />
          <UsageBanner />
          <main className="min-w-0 flex-1 overflow-x-hidden overflow-y-auto">{children}</main>
        </div>
        <CommandPalette />
        <TourGuide />
        <FloatingAsk />
      </div>
    </WorkspaceProvider>
  );
}
