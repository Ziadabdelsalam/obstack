import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { rotations, escalationPolicies, seedChannels, alertRouting } from "@/mock/oncall";
import { ChannelToggles } from "@/components/oncall/ChannelToggles";

// Mock world's "today" is fixed at Sun Aug 9, 2026 — never derived from the real clock.
const TODAY = "Sun";

export default function OncallPage() {
  return (
    <div className="px-5 py-4">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="font-display text-[19px] font-semibold text-ink">On-call &amp; notifications</h1>
        <span className="font-mono text-[11px] text-faint">{rotations.length} rotations · {escalationPolicies.length} policies</span>
      </div>

      {/* 1. Now on call */}
      <section className="mb-4">
        <h2 className="mb-2 font-mono text-[11px] uppercase tracking-widest text-faint">Now on call</h2>
        <div className="grid gap-3 md:grid-cols-3">
          {rotations.map((r) => (
            <div key={r.team} className="rounded-lg border border-line bg-surface p-3.5">
              <span className="block text-[13.5px] font-medium text-ink">{r.team}</span>
              <div className="mt-2 flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: "var(--color-ok)" }} />
                <span className="text-[13px] text-ink">{r.primary}</span>
              </div>
              <span className="mt-1 block font-mono text-[10.5px] text-faint">secondary: {r.secondary}</span>
              <span className="mt-0.5 block font-mono text-[10.5px] text-faint">until {r.until}</span>
            </div>
          ))}
        </div>
      </section>

      {/* 2. Rotation schedule */}
      <section className="mb-4">
        <h2 className="mb-2 font-mono text-[11px] uppercase tracking-widest text-faint">Rotation schedule</h2>
        <div className="space-y-2">
          {rotations.map((r) => (
            <div key={r.team} className="rounded-lg border border-line bg-surface p-3.5">
              <span className="mb-2 block text-[13px] font-medium text-ink">{r.team}</span>
              <div className="grid grid-cols-7 gap-1.5">
                {r.week.map((d) => (
                  <div
                    key={d.day}
                    className="rounded-md border px-1.5 py-1.5 text-center"
                    style={{
                      borderColor: d.day === TODAY ? "var(--color-line-strong)" : "var(--color-line)",
                    }}
                  >
                    <span className="block font-mono text-[9.5px] uppercase tracking-wide text-faint">{d.day}</span>
                    <span className="block text-[12px] text-ink">{d.primary}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* 3. Escalation policies */}
      <section className="mb-4">
        <h2 className="mb-2 font-mono text-[11px] uppercase tracking-widest text-faint">Escalation policies</h2>
        <div className="space-y-2">
          {escalationPolicies.map((p) => (
            <div key={p.id} className="rounded-lg border border-line bg-surface p-3.5">
              <div className="flex items-center gap-2">
                <span className="text-[13.5px] font-medium text-ink">{p.name}</span>
                <span className="rounded-[3px] bg-raised px-1.5 py-px font-mono text-[9.5px] tracking-wide text-faint">
                  {p.team}
                </span>
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5 font-mono text-[10.5px] text-mid">
                {p.steps.map((s, i) => (
                  <span key={s} className="flex items-center gap-1.5">
                    {i > 0 && <span className="text-faint">&rarr;</span>}
                    <span>{s}</span>
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* 4. Notification channels */}
      <section className="mb-4">
        <h2 className="mb-2 font-mono text-[11px] uppercase tracking-widest text-faint">Notification channels</h2>
        <div className="rounded-lg border border-line bg-surface p-3.5">
          <ChannelToggles />
        </div>
      </section>

      {/* 5. Alert routing */}
      <section>
        <h2 className="mb-2 font-mono text-[11px] uppercase tracking-widest text-faint">Alert routing</h2>
        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="w-full min-w-[560px] border-collapse">
            <thead>
              <tr className="border-b border-line text-left">
                <th className="px-3 py-2 font-mono text-[10.5px] uppercase tracking-wide text-faint">Rule</th>
                <th className="px-3 py-2 font-mono text-[10.5px] uppercase tracking-wide text-faint">Policy</th>
                <th className="px-3 py-2 font-mono text-[10.5px] uppercase tracking-wide text-faint">Channels</th>
              </tr>
            </thead>
            <tbody>
              {alertRouting.map((entry) => {
                const policy = escalationPolicies.find((p) => p.id === entry.policyId);
                const channelNames = entry.channelIds
                  .map((id) => seedChannels.find((c) => c.id === id)?.name ?? id)
                  .join(", ");
                return (
                  <tr key={entry.rule} className="border-b border-line last:border-0">
                    <td className="px-3 py-2 text-[12.5px] text-ink">{entry.rule}</td>
                    <td className="px-3 py-2 text-[12.5px] text-mid">{policy?.name ?? entry.policyId}</td>
                    <td className="px-3 py-2 font-mono text-[10.5px] text-faint">{channelNames}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <Link
          href="/app/alerts"
          className="mt-2 inline-flex items-center gap-1 font-mono text-[11px] hover:underline"
          style={{ color: "var(--color-api)" }}
        >
          Manage rules <ArrowUpRight className="h-3 w-3" />
        </Link>
      </section>
    </div>
  );
}
