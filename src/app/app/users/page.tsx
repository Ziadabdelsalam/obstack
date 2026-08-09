import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { impactedUsers } from "@/mock/users";

const riskStyle = {
  "at-risk": { color: "var(--color-err)", label: "AT RISK" },
  degraded: { color: "var(--color-warn)", label: "DEGRADED" },
  healthy: { color: "var(--color-ok)", label: "HEALTHY" },
} as const;

export default function UsersPage() {
  const atRisk = impactedUsers.filter((u) => u.risk !== "healthy").length;
  return (
    <div className="px-5 py-4">
      <div className="mb-1 flex items-center justify-between">
        <h1 className="font-display text-[19px] font-semibold text-ink">Users</h1>
        <span className="font-mono text-[11px] text-faint">
          {atRisk} of {impactedUsers.length} experienced failures or slowness · 7d
        </span>
      </div>
      <p className="mb-4 text-[12.5px] text-mid">
        Failures grouped by the people who felt them — observability in product language, not pod
        language.
      </p>

      <div className="space-y-2">
        {impactedUsers.map((u) => {
          const r = riskStyle[u.risk];
          return (
            <section
              key={u.user}
              className="rounded-lg border bg-surface p-3.5"
              style={{
                borderColor:
                  u.risk === "at-risk"
                    ? "color-mix(in srgb, var(--color-err) 40%, var(--color-line))"
                    : "var(--color-line)",
              }}
            >
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <span
                  className="rounded-[3px] px-1.5 py-px font-mono text-[9.5px] tracking-wide"
                  style={{ color: r.color, background: `color-mix(in srgb, ${r.color} 12%, transparent)` }}
                >
                  {r.label}
                </span>
                <span className="min-w-0">
                  <span className="block text-[13.5px] font-medium text-ink">{u.org}</span>
                  <span className="block font-mono text-[10.5px] text-faint">
                    {u.user} · {u.plan}
                  </span>
                </span>
                <span className="ml-auto flex items-center gap-5">
                  <span className="text-right">
                    <span className="block font-mono text-[13px] text-ink">{u.reqs7d.toLocaleString()}</span>
                    <span className="block font-mono text-[9.5px] uppercase tracking-wider text-faint">reqs · 7d</span>
                  </span>
                  <span className="text-right">
                    <span
                      className="block font-mono text-[13px]"
                      style={{ color: u.failures7d > 0 ? "var(--color-err)" : "var(--color-mid)" }}
                    >
                      {u.failures7d}
                    </span>
                    <span className="block font-mono text-[9.5px] uppercase tracking-wider text-faint">failures</span>
                  </span>
                  <span className="text-right">
                    <span
                      className="block font-mono text-[13px]"
                      style={{ color: u.slow7d > 5 ? "var(--color-warn)" : "var(--color-mid)" }}
                    >
                      {u.slow7d}
                    </span>
                    <span className="block font-mono text-[9.5px] uppercase tracking-wider text-faint">slow &gt;5s</span>
                  </span>
                </span>
              </div>
              {u.lastFailure && (
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-line bg-raised px-2.5 py-1.5">
                  <span className="font-mono text-[9.5px] uppercase tracking-widest text-faint">last incident</span>
                  <span className="font-mono text-[11.5px] text-mid">{u.lastFailure.label}</span>
                  <span className="font-mono text-[10px] text-faint">{u.lastFailure.when}</span>
                  <Link
                    href={u.lastFailure.traceId ? `/app/traces/${u.lastFailure.traceId}` : u.lastFailure.href!}
                    className="ml-auto inline-flex items-center gap-1 font-mono text-[11px] hover:underline"
                    style={{ color: "var(--color-api)" }}
                  >
                    open <ArrowUpRight className="h-3 w-3" />
                  </Link>
                </div>
              )}
            </section>
          );
        })}
      </div>

      <p className="mt-3 font-mono text-[10.5px] leading-relaxed text-faint">
        users are attributed from trace context (user.id / session.id) — set by the SDK or your own
        OTel attributes. Meridian&apos;s ops account absorbed all 41 INC-42 failures; their CSM was
        notified via the incident.
      </p>
    </div>
  );
}
