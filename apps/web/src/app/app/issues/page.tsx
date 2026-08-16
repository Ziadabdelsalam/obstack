import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { issues } from "@/mock/issues";
import { LayerChip } from "@/components/ui/LayerChip";

const statusStyle = {
  ongoing: { color: "var(--color-warn)", label: "ONGOING" },
  new: { color: "var(--color-err)", label: "NEW" },
  resolved: { color: "var(--color-ok)", label: "RESOLVED" },
} as const;

function Spark({ data, hot }: { data: number[]; hot: boolean }) {
  const max = Math.max(...data, 1);
  return (
    <span className="flex h-6 items-end gap-[2px]" aria-hidden>
      {data.map((v, i) => (
        <span
          key={i}
          className="w-[5px] rounded-[1px]"
          style={{
            height: `${Math.max((v / max) * 100, v > 0 ? 12 : 4)}%`,
            background: v === 0 ? "var(--color-overlay)" : hot && i >= data.length - 2 ? "var(--color-err)" : "var(--color-line-strong)",
          }}
        />
      ))}
    </span>
  );
}

export default function IssuesPage() {
  const open = issues.filter((i) => i.status !== "resolved");
  const resolved = issues.filter((i) => i.status === "resolved");

  return (
    <div className="px-5 py-4">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="font-display text-[19px] font-semibold text-ink">Issues</h1>
        <span className="font-mono text-[11px] text-faint">
          {open.length} open · grouped by error fingerprint
        </span>
      </div>

      <div className="space-y-2" data-tour="issues">
        {[...open, ...resolved].map((issue) => {
          const st = statusStyle[issue.status];
          const href = issue.exampleTraceId ? `/app/traces/${issue.exampleTraceId}` : issue.exampleLink!;
          return (
            <section
              key={issue.fingerprint}
              className="rounded-lg border border-line bg-surface p-3.5"
              style={issue.status === "resolved" ? { opacity: 0.65 } : undefined}
            >
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <span
                  className="rounded-[3px] px-1.5 py-px font-mono text-[9.5px] tracking-wide"
                  style={{ color: st.color, background: `color-mix(in srgb, ${st.color} 12%, transparent)` }}
                >
                  {st.label}
                </span>
                <h2 className="min-w-0 flex-1 truncate font-mono text-[13px] text-ink">{issue.title}</h2>
                <Spark data={issue.spark} hot={issue.status !== "resolved"} />
                <span className="w-14 text-right font-mono text-[15px] text-ink">{issue.count7d}</span>
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1">
                <LayerChip layer={issue.layer} />
                <span className="font-mono text-[10.5px] text-faint">{issue.service}</span>
                <span className="font-mono text-[10.5px] text-faint">
                  first seen {issue.firstSeen} · last {issue.lastSeen} · {issue.count7d}× in 7d
                </span>
                <Link
                  href={href}
                  className="ml-auto inline-flex items-center gap-1 font-mono text-[11px] hover:underline"
                  style={{ color: "var(--color-api)" }}
                >
                  {issue.exampleTraceId ? "example trace" : "matching traces"} <ArrowUpRight className="h-3 w-3" />
                </Link>
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
