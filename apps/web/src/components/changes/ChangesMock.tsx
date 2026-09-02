import Link from "next/link";
import { ArrowUpRight, Rocket, Settings2, Scaling, KeyRound, Flag, Boxes } from "lucide-react";
import { changes, type ChangeKind } from "@/mock/changes";

const kindStyle: Record<ChangeKind, { icon: typeof Rocket; color: string; label: string }> = {
  deploy: { icon: Rocket, color: "var(--color-agent)", label: "deploy" },
  config: { icon: Settings2, color: "var(--color-api)", label: "config" },
  scale: { icon: Scaling, color: "var(--color-tool)", label: "scale" },
  secret: { icon: KeyRound, color: "var(--color-warn)", label: "secret" },
  flag: { icon: Flag, color: "var(--color-llm)", label: "flag" },
  infra: { icon: Boxes, color: "var(--color-infra)", label: "k8s" },
};

export function ChangesMock() {
  return (
    <div className="mx-auto max-w-3xl px-5 py-4">
      <div className="mb-1 flex items-center justify-between">
        <h1 className="font-display text-[19px] font-semibold text-ink">Changes</h1>
        <span className="font-mono text-[11px] text-faint">
          deploys · config · scaling · secrets · flags — one answer to “what changed?”
        </span>
      </div>
      <p className="mb-5 text-[12.5px] text-mid">
        Everything that mutated your system, newest first. Entries inside an incident window are
        marked — three of today&apos;s changes are the INC-42 story.
      </p>

      <div className="relative ml-2 border-l border-line-strong pl-6">
        {changes.map((c, i) => {
          const s = kindStyle[c.kind];
          const Icon = s.icon;
          return (
            <div key={i} className="relative pb-5 last:pb-0">
              <span
                className="absolute -left-[35px] flex h-[18px] w-[18px] items-center justify-center rounded-full border bg-surface"
                style={{ borderColor: s.color }}
              >
                <Icon className="h-2.5 w-2.5" style={{ color: s.color }} />
              </span>
              <div
                className="rounded-lg border bg-surface p-3"
                style={{
                  borderColor: c.incident
                    ? "color-mix(in srgb, var(--color-err) 35%, var(--color-line))"
                    : "var(--color-line)",
                }}
              >
                <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                  <span className="font-mono text-[9px] uppercase tracking-widest" style={{ color: s.color }}>
                    {s.label}
                  </span>
                  <span className="font-mono text-[10.5px] text-faint">{c.at}</span>
                  <span className="font-mono text-[10.5px] text-faint">by {c.who}</span>
                  {c.incident && (
                    <span
                      className="ml-auto rounded-[3px] px-1.5 py-px font-mono text-[9px] tracking-wide"
                      style={{
                        color: "var(--color-err)",
                        background: "color-mix(in srgb, var(--color-err) 12%, transparent)",
                      }}
                    >
                      INC-42 WINDOW
                    </span>
                  )}
                </div>
                <p className="mt-1 text-[13.5px] font-medium text-ink">{c.title}</p>
                <p className="mt-0.5 text-[12.5px] leading-relaxed text-mid">{c.detail}</p>
                {c.link && (
                  <Link
                    href={c.link.href}
                    className="mt-1.5 inline-flex items-center gap-1 font-mono text-[11px] hover:underline"
                    style={{ color: "var(--color-api)" }}
                  >
                    {c.link.label} <ArrowUpRight className="h-3 w-3" />
                  </Link>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
