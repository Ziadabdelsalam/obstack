import { SideNav } from "@/components/shell/SideNav";
import { CommandPalette } from "@/components/shell/CommandPalette";
import { UsageBanner } from "@/components/shell/UsageBanner";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen">
      <SideNav />
      <main className="min-w-0 flex-1 overflow-x-hidden">
        <UsageBanner />
        {children}
      </main>
      <CommandPalette />
    </div>
  );
}
