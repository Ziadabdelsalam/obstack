import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { USERS_CAP, type ImpactedUser } from "@/lib/users-types";

const riskStyle = {
  "at-risk": { color: "var(--color-err)", label: "AT RISK" },
  degraded: { color: "var(--color-warn)", label: "DEGRADED" },
  healthy: { color: "var(--color-ok)", label: "HEALTHY" },
} as const;

/**
 * D398/D392: a server component (no client directive) — every selection here
 * is a `<Link>` to a trace, never a client-side interaction, so there is no
 * reason to ship client JS for interactivity that does not exist. Fed
 * exclusively by `server/queries/users.ts` through `users/page.tsx` — no
 * `@/mock/` import anywhere in this file.
 *
 * ABSENT: `org`, `plan` (D398 — fixture-only fields the trace-derived
 * contract has no answer for).
 */
export function UsersLive({
  users,
  totalUsers,
}: {
  users: ImpactedUser[];
  totalUsers: number;
}) {
  if (users.length === 0) {
    return (
      <div className="px-5 py-4">
        <h1 className="mb-4 font-display text-[19px] font-semibold text-ink">Users</h1>
        <div className="rounded-lg border border-line bg-surface px-3.5 py-5">
          <p className="max-w-prose text-[12.5px] leading-relaxed text-mid">
            no span in the last 24h carried <code className="font-mono">enduser.id</code> or{" "}
            <code className="font-mono">user.id</code> — set one on your root span to see impacted
            users.
          </p>
        </div>
      </div>
    );
  }

  const atRisk = users.filter((u) => u.risk !== "healthy").length;

  return (
    <div className="px-5 py-4">
      <div className="mb-1 flex items-center justify-between">
        <h1 className="font-display text-[19px] font-semibold text-ink">Users</h1>
        <span className="font-mono text-[11px] text-faint">
          {atRisk} of {users.length} experienced failures or slowness · last 24h
        </span>
      </div>
      <p className="mb-1 text-[12.5px] text-mid">
        Failures grouped by the people who felt them — observability in product language, not pod
        language.
      </p>
      <p className="mb-4 font-mono text-[10.5px] text-faint">
        at-risk: failures ≥10% of requests · degraded: failures ≥2% or slow (≥2s) ≥20% of requests ·
        else healthy
      </p>

      {totalUsers > USERS_CAP && (
        <p className="mb-3 font-mono text-[10.5px] text-faint">
          showing {USERS_CAP} of {totalUsers} users by requests
        </p>
      )}

      <div className="space-y-2" data-tour="users">
        {users.map((u) => {
          const r = riskStyle[u.risk];
          return (
            <section
              key={u.userId}
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
                <span className="min-w-0 truncate font-mono text-[13px] text-ink">{u.userId}</span>
                <span className="ml-auto flex items-center gap-5">
                  <span className="text-right">
                    <span className="block font-mono text-[13px] text-ink">{u.requests.toLocaleString()}</span>
                    <span className="block font-mono text-[9.5px] uppercase tracking-wider text-faint">reqs · 24h</span>
                  </span>
                  <span className="text-right">
                    <span
                      className="block font-mono text-[13px]"
                      style={{ color: u.failures > 0 ? "var(--color-err)" : "var(--color-mid)" }}
                    >
                      {u.failures}
                    </span>
                    <span className="block font-mono text-[9.5px] uppercase tracking-wider text-faint">failures</span>
                  </span>
                  <span className="text-right">
                    <span
                      className="block font-mono text-[13px]"
                      style={{ color: u.slow > 0 ? "var(--color-warn)" : "var(--color-mid)" }}
                    >
                      {u.slow}
                    </span>
                    <span className="block font-mono text-[9.5px] uppercase tracking-wider text-faint">slow = ≥2s</span>
                  </span>
                </span>
              </div>
              {u.lastFailure && (
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-line bg-raised px-2.5 py-1.5">
                  <span className="font-mono text-[9.5px] uppercase tracking-widest text-faint">last failure</span>
                  <span className="font-mono text-[11.5px] text-mid">{u.lastFailure.rootName}</span>
                  <span className="font-mono text-[10px] text-faint">{u.lastFailure.at}</span>
                  <Link
                    href={`/app/traces/${u.lastFailure.traceId}`}
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
    </div>
  );
}
