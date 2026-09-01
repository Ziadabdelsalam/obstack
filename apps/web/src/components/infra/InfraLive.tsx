import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { fmtBytes, fmtClock, fmtCores } from "@/lib/format";
import {
  INFRA_NODE_CAP,
  INFRA_POD_CAP,
  INFRA_RECS_CAP,
  type InfraSnapshot,
  type RightsizingRec,
} from "@/lib/infra-types";

/**
 * The infrastructure surface, live (D367/D459): a SERVER component — every
 * control here is a `<Link>` — fed exclusively by `server/queries/infra.ts`
 * through `infra/page.tsx`. No `@/mock/` import anywhere in this file, and no
 * price: obstack has no price input for compute, so a right-sizing "saving"
 * would be a number nobody here holds (D362 — the figure is ABSENT, not
 * marked as sample).
 *
 * FOUR states, because the two collector legs fail independently (D13/D459):
 * neither leg reporting is the empty state; the kubelet leg alone gives usage
 * without readiness, phase, restarts or limits; the cluster leg alone gives
 * those without usage; both is the full render. The missing leg is NAMED in
 * prose above the tables, and every cell it would have filled shows `—`.
 *
 * `n.pool`, the node's age and a cluster name are absent for the usual reason
 * (D13): the metric stream carries no counterpart, so they are not rendered
 * rather than invented.
 */

/** D459(a): neither leg has reported inside the freshness window. */
const NO_METRICS_SENTENCE =
  "No cluster metrics yet. The obstack-collector chart ships node and pod metrics from chart 0.6.0 — install or upgrade it, and this page fills in from the kubelet and the cluster API.";
/** D459(b): the kubelet leg alone. */
const KUBELET_ONLY_NOTE =
  "Readiness, pod phase, restarts, requests and limits come from the cluster collector (collector.cluster.enabled), which is off or not yet reporting — those cells show — until it does.";
/** D459(d): the cluster leg alone. */
const CLUSTER_ONLY_NOTE =
  "CPU and memory usage come from the node collector (the DaemonSet's kubelet_stats receiver), which is not reporting — check its nodes/stats access; usage cells show — until it does.";
/** D458: the panel's basis, stated whether or not it has anything to say. */
const RECS_BASIS =
  "Peak usage against each container's current limit over the last 24h; a limit is called oversized only after 12h of observation. No prices — obstack has no price input for compute.";
const RECS_EMPTY = "Nothing to right-size in the last 24h.";
const RECS_NEEDS_LIMITS = "Right-sizing needs container limits from the cluster collector.";
const RECS_NEEDS_USAGE = "Right-sizing needs usage from the node collector.";

/** Every missing metric renders as this, and never as a zero (D13). */
const MISSING = "—";

function UtilBar({ pct }: { pct: number }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-overlay">
      <div
        className="h-full rounded-full"
        style={{
          width: `${Math.min(100, pct)}%`,
          background: pct >= 80 ? "var(--color-warn)" : "var(--color-api)",
        }}
      />
    </div>
  );
}

/**
 * A node meter: a bar as a percentage of allocatable, and — when the cluster
 * leg has not told us what allocatable is — the absolute usage instead. A
 * percentage of an unknown denominator is the one thing it must not print.
 */
function NodeMeter({
  label,
  used,
  allocatable,
  fmt,
}: {
  label: string;
  used: number | null;
  allocatable: number | null;
  fmt: (n: number) => string;
}) {
  const pct =
    used !== null && allocatable !== null && allocatable > 0
      ? Math.round((used / allocatable) * 100)
      : null;
  return (
    <div className="flex items-center gap-2">
      <span className="w-7 font-mono text-[9.5px] text-faint">{label}</span>
      {pct === null ? (
        <span className="flex-1 font-mono text-[10px] text-mid">
          {used === null ? MISSING : fmt(used)}
        </span>
      ) : (
        <>
          <UtilBar pct={pct} />
          <span className="w-8 text-right font-mono text-[10px] text-mid">{`${pct}%`}</span>
        </>
      )}
    </div>
  );
}

/**
 * A usage cell: the observed value, then the limit and the ratio only when the
 * pod's limit is COMPLETE (D457 — a partial sum would understate the limit and
 * overstate the percentage). One string, one text node: the sentence a reader
 * sees is the sentence the HTML carries.
 */
function usageCell(used: number | null, limit: number | null, fmt: (n: number) => string): string {
  const observed = used === null ? MISSING : fmt(used);
  if (limit === null) return observed;
  const ratio = used !== null && limit > 0 ? ` · ${Math.round((used / limit) * 100)}%` : "";
  return `${observed} / ${fmt(limit)}${ratio}`;
}

/** D458's three sentences, each stated with its window and its basis. */
function recSentence(r: RightsizingRec): string {
  const target = `${r.namespace}/${r.pod}/${r.container}`;
  const pct = Math.round(r.ratio * 100);
  const hours = Math.round(r.observedHours);
  if (r.kind === "cpu-near-limit") {
    return `${target} peaked at ${pct}% of its ${fmtCores(r.limit)} CPU limit over the last ${hours}h — near its limit`;
  }
  const verdict = r.kind === "memory-limit-oversized" ? "the limit is oversized" : "near its limit";
  return `${target} peaked at ${pct}% of its ${fmtBytes(r.limit)} memory limit over the last ${hours}h — ${verdict}`;
}

export function InfraLive({ snapshot }: { snapshot: InfraSnapshot }) {
  const {
    nodes,
    totalNodes,
    pods,
    totalPods,
    recs,
    totalRecs,
    hasKubeletMetrics,
    hasClusterMetrics,
    asOf,
  } = snapshot;

  if (!hasKubeletMetrics && !hasClusterMetrics) {
    return (
      <div className="px-5 py-4">
        <h1 className="mb-4 font-display text-[19px] font-semibold text-ink">Infrastructure</h1>
        <section className="rounded-lg border border-line bg-surface p-6 text-center">
          <p className="mx-auto max-w-[620px] text-[13px] leading-relaxed text-mid">
            {NO_METRICS_SENTENCE}
          </p>
          <Link
            href="/app/docs/self-hosting/helm-chart"
            className="mt-3 inline-block font-mono text-[12px] text-faint hover:text-ink"
          >
            Helm chart docs
          </Link>
        </section>
      </div>
    );
  }

  const note = !hasClusterMetrics ? KUBELET_ONLY_NOTE : !hasKubeletMetrics ? CLUSTER_ONLY_NOTE : null;

  return (
    <div className="px-5 py-4">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="font-display text-[19px] font-semibold text-ink">Infrastructure</h1>
        <span className="font-mono text-[11px] text-faint">
          {`${totalNodes} nodes · ${totalPods} pods · as of ${asOf === null ? MISSING : fmtClock(asOf)}`}
        </span>
      </div>

      {note !== null && (
        <p className="mb-4 max-w-[880px] font-mono text-[10.5px] leading-relaxed text-faint">
          {note}
        </p>
      )}

      {/* nodes — D402: the truncation statement is part of the answer, so it
          renders only when the cap actually cut something. */}
      {totalNodes > INFRA_NODE_CAP && (
        <p className="mb-2 font-mono text-[10.5px] text-faint">
          {`showing ${INFRA_NODE_CAP} of ${totalNodes} nodes`}
        </p>
      )}
      <div className="mb-5 grid grid-cols-2 gap-3 xl:grid-cols-4">
        {nodes.map((n) => (
          <div key={n.name} className="rounded-lg border border-line bg-surface p-3.5">
            <div className="flex items-center justify-between">
              <p className="truncate font-mono text-[12px] text-ink">{n.name}</p>
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{
                  background:
                    n.ready === null
                      ? "var(--color-faint)"
                      : n.ready
                        ? "var(--color-ok)"
                        : "var(--color-err)",
                }}
              />
            </div>
            <p className="mt-0.5 font-mono text-[10px] text-faint">{`${n.podCount} pods`}</p>
            <div className="mt-2.5 space-y-1.5">
              <NodeMeter
                label="cpu"
                used={n.cpuUsageCores}
                allocatable={n.cpuAllocatableCores}
                fmt={fmtCores}
              />
              <NodeMeter
                label="mem"
                used={n.memWorkingSetBytes}
                allocatable={n.memAllocatableBytes}
                fmt={fmtBytes}
              />
            </div>
          </div>
        ))}
      </div>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        {/* pods */}
        <section className="min-w-0 overflow-x-auto rounded-lg border border-line bg-surface">
          {totalPods > INFRA_POD_CAP && (
            <p className="border-b border-line px-3.5 py-2 font-mono text-[10.5px] text-faint">
              {`showing ${INFRA_POD_CAP} of ${totalPods} pods`}
            </p>
          )}
          <table className="w-full min-w-[760px] border-collapse">
            <thead>
              <tr className="border-b border-line text-left font-mono text-[10px] uppercase tracking-widest text-faint">
                <th className="py-2 pl-3.5 font-medium">pod</th>
                <th className="py-2 font-medium">node</th>
                <th className="py-2 font-medium">phase</th>
                <th className="py-2 text-right font-medium">restarts</th>
                <th className="w-[190px] py-2 pl-6 font-medium">memory</th>
                <th className="py-2 pl-6 font-medium">cpu</th>
                <th className="py-2 pr-3.5 text-right font-medium">logs</th>
              </tr>
            </thead>
            <tbody>
              {pods.map((p) => (
                <tr key={`${p.namespace}/${p.name}`} className="border-b border-line/50 last:border-0">
                  <td className="py-2.5 pl-3.5">
                    <span className="block truncate font-mono text-[11.5px] text-ink">
                      {`${p.namespace}/${p.name}`}
                    </span>
                  </td>
                  <td className="py-2.5 font-mono text-[10px] text-faint">{p.node ?? MISSING}</td>
                  <td className="py-2.5 font-mono text-[10.5px] text-mid">{p.phase ?? MISSING}</td>
                  <td
                    className="py-2.5 text-right font-mono text-[11.5px]"
                    style={{
                      color:
                        p.restarts === null || p.restarts === 0
                          ? "var(--color-faint)"
                          : p.restarts >= 3
                            ? "var(--color-err)"
                            : "var(--color-warn)",
                    }}
                  >
                    {p.restarts === null ? MISSING : p.restarts}
                  </td>
                  <td className="py-2.5 pl-6 font-mono text-[10.5px] text-mid">
                    {usageCell(p.memWorkingSetBytes, p.memLimitBytes, fmtBytes)}
                  </td>
                  <td className="py-2.5 pl-6 font-mono text-[10.5px] text-mid">
                    {usageCell(p.cpuUsageCores, p.cpuLimitCores, fmtCores)}
                  </td>
                  <td className="py-2.5 pr-3.5 text-right">
                    {/* D61: pod intent is the logs surface's POD FILTER, with
                        the whole name — free text there reads the log body
                        only (D51(e)). */}
                    <Link
                      href={`/app/logs?pod=${encodeURIComponent(p.name)}`}
                      className="inline-flex items-center gap-0.5 font-mono text-[10px] hover:underline"
                      style={{ color: "var(--color-api)" }}
                    >
                      logs <ArrowUpRight className="h-2.5 w-2.5" />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        {/* right-sizing */}
        <section className="min-w-0">
          <h2 className="mb-2 font-mono text-[11px] uppercase tracking-widest text-faint">
            right-sizing recommendations
          </h2>
          <div className="space-y-2">
            {!hasClusterMetrics ? (
              <p className="text-[12px] leading-relaxed text-mid">{RECS_NEEDS_LIMITS}</p>
            ) : !hasKubeletMetrics ? (
              <p className="text-[12px] leading-relaxed text-mid">{RECS_NEEDS_USAGE}</p>
            ) : recs.length === 0 ? (
              <p className="text-[12px] leading-relaxed text-mid">{RECS_EMPTY}</p>
            ) : (
              <>
                {recs.map((r) => (
                  <div
                    key={`${r.namespace}/${r.pod}/${r.container}/${r.kind}`}
                    className="rounded-lg border border-line bg-surface p-3.5"
                  >
                    <p className="font-mono text-[11px] leading-relaxed text-mid">{recSentence(r)}</p>
                  </div>
                ))}
                {totalRecs > INFRA_RECS_CAP && (
                  <p className="font-mono text-[10.5px] text-faint">
                    {`showing ${INFRA_RECS_CAP} of ${totalRecs} recommendations`}
                  </p>
                )}
              </>
            )}
            <p className="pt-1 font-mono text-[10px] leading-relaxed text-faint">{RECS_BASIS}</p>
          </div>
        </section>
      </div>
    </div>
  );
}
