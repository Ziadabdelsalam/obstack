import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { LayerChip } from "@/components/ui/LayerChip";
import { RECENT_HOURS, WINDOW_HOURS, type Issue, type IssueStatus } from "@/lib/issues-types";

/**
 * The issues surface, live branch (D367/D392): a SERVER component fed entirely
 * by `server/queries/issues.ts` through `issues/page.tsx`. There is nothing to
 * click here that a URL cannot express, so it ships no client JavaScript at
 * all — and it imports no `@/mock/*` (A2).
 *
 * What is deliberately ABSENT (D361, the stateless fence): assign, mute and
 * resolve. This build stores no per-issue state, so a button promising any of
 * them would be a lie about what the product remembers. `status` is recency
 * and only recency, and the legend below says so rather than leaving a reader
 * to assume someone closed something.
 *
 * `Spark` and `statusStyle` are duplicated from `IssuesMock` on purpose
 * (D391): the mock's sparkline is 14 fixture buckets over 7 days, this one is
 * 24 measured hours — same pixels, different claim, and a shared component
 * would have to be told which.
 */

const statusStyle: Record<IssueStatus, { color: string; label: string }> = {
  ongoing: { color: "var(--color-warn)", label: "ONGOING" },
  new: { color: "var(--color-err)", label: "NEW" },
  resolved: { color: "var(--color-ok)", label: "RESOLVED" },
};

/** One bar per hour, oldest first; a zero-height bar is a measured zero, not a gap. */
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

export function IssuesLive({ issues, total }: { issues: Issue[]; total: number }) {
  const stillErroring = issues.filter((i) => i.status !== "resolved").length;

  return (
    <div className="px-5 py-4">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="font-display text-[19px] font-semibold text-ink">Issues</h1>
        <span className="font-mono text-[11px] text-faint">
          {stillErroring} still erroring · grouped by error fingerprint · last {WINDOW_HOURS}h
        </span>
      </div>

      <p className="mb-3 max-w-prose font-mono text-[10.5px] leading-relaxed text-faint">
        Error spans from the last {WINDOW_HOURS}h, grouped by service, layer and span name together
        with the error message once ids, numbers and quoted strings are collapsed. Status is
        recency, nothing else: NEW = every occurrence inside the last {RECENT_HOURS}h · ONGOING =
        occurrences on both sides of that line · RESOLVED = none inside the last {RECENT_HOURS}h.
      </p>

      {/* D402: the truncation and the truncated list are one answer — stated
          only when the read actually was truncated. */}
      {total > issues.length && (
        <p className="mb-3 font-mono text-[10.5px] text-faint">
          showing top {issues.length} of {total} by occurrences in the last {WINDOW_HOURS}h
        </p>
      )}

      {issues.length === 0 ? (
        <div className="rounded-lg border border-line bg-surface px-3.5 py-5">
          <p className="text-[13px] text-ink">No errors in the last {WINDOW_HOURS}h.</p>
          <p className="mt-1 max-w-prose text-[12.5px] leading-relaxed text-mid">
            Nothing in this workspace has sent a span with an error status in that window. Issues
            are grouped from those spans as they arrive — there is nothing to acknowledge here.
          </p>
        </div>
      ) : (
        <div className="space-y-2" data-tour="issues">
          {/* Rendered in the order the read ranked them (occurrences, descending),
              so the list matches the cap the banner above states. */}
          {issues.map((issue) => {
            const st = statusStyle[issue.status];
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
                  <span className="w-14 text-right font-mono text-[15px] text-ink">{issue.count}</span>
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1">
                  <LayerChip layer={issue.layer} />
                  <span className="font-mono text-[10.5px] text-faint">{issue.service || "—"}</span>
                  <span className="font-mono text-[10.5px] text-faint">
                    first seen in this {WINDOW_HOURS}h window {issue.firstSeenAt} · last{" "}
                    {issue.lastSeenAt} · {issue.count}× in {WINDOW_HOURS}h
                  </span>
                  <Link
                    href={`/app/traces/${issue.exampleTraceId}`}
                    className="ml-auto inline-flex items-center gap-1 font-mono text-[11px] hover:underline"
                    style={{ color: "var(--color-api)" }}
                  >
                    example trace <ArrowUpRight className="h-3 w-3" />
                  </Link>
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
