import Link from "next/link";
import { ArrowUpRight, BookOpen } from "lucide-react";
import {
  formatAlertCondition,
  type AlertEventRow,
  type AlertRuleRow,
  type NotificationChannelRow,
} from "@/lib/alert-types";
import { ChannelManager, NewRuleButton, RuleControls } from "./AlertsEditor";

/**
 * Alerts, live (S7.1 T6): a SERVER component fed exclusively by
 * `server/alerts.ts` through `alerts/page.tsx`. No `@/mock/` import anywhere
 * in this file — the fixture's anomaly events (token-spend spike, tool-failure
 * cluster) and one-click remediation `actions` have no evaluated counterpart,
 * so they are ABSENT rather than staged (D13/packet §0); what the feed shows
 * is an event a rule's own evaluation produced, with its delivery truth —
 * `failed` included, honestly (D485).
 *
 * The interactive parts live next door in `AlertsEditor.tsx` (client): every
 * mutation is a server action, and its answer is either the store's own
 * sentence (printed verbatim) or the fresh row, after which `router.refresh()`
 * re-reads this page — one definition of what the surface shows.
 */
const sevStyle = {
  critical: { color: "var(--color-err)", label: "CRITICAL" },
  warning: { color: "var(--color-warn)", label: "WARNING" },
  info: { color: "var(--color-mid)", label: "INFO" },
} as const;

/** D485: the delivery truth, one style per state — a failed webhook is a fact
 *  the feed states, never a row quietly dropped. */
const deliveryStyle = {
  pending: { color: "var(--color-faint)", label: "pending" },
  delivered: { color: "var(--color-ok)", label: "delivered" },
  failed: { color: "var(--color-err)", label: "delivery failed" },
} as const;

export function AlertsLive({
  rules,
  events,
  channels,
}: {
  rules: AlertRuleRow[];
  events: AlertEventRow[];
  channels: NotificationChannelRow[];
}) {
  const active = rules.filter((r) => r.enabled).length;

  return (
    <div className="px-5 py-4">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="font-display text-[19px] font-semibold text-ink">Alerts</h1>
        <NewRuleButton channels={channels} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
        {/* the event feed — what evaluation produced, newest first */}
        <section className="min-w-0">
          <h2 className="mb-2 font-mono text-[11px] uppercase tracking-widest text-faint">
            events · newest first
          </h2>
          {events.length === 0 ? (
            <div className="rounded-lg border border-line bg-surface p-6 text-center">
              <p className="font-mono text-[13px] text-mid">
                no alert events yet — enabled rules evaluate against your own telemetry about once
                a minute
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {events.map((e) => (
                <div key={e.id} className="rounded-lg border border-line bg-surface p-3.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className="rounded-[3px] px-1.5 py-px font-mono text-[9.5px] tracking-wide"
                      style={{
                        color: sevStyle[e.severity].color,
                        background: `color-mix(in srgb, ${sevStyle[e.severity].color} 12%, transparent)`,
                      }}
                    >
                      {sevStyle[e.severity].label}
                    </span>
                    <h3 className="text-[13.5px] font-medium text-ink">{e.title}</h3>
                    <span className="ml-auto font-mono text-[10.5px] text-faint">
                      {e.at.slice(0, 16).replace("T", " ")} UTC
                    </span>
                  </div>
                  <p className="mt-1.5 text-[12.5px] leading-relaxed text-mid">{e.detail}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-3">
                    <span
                      className="font-mono text-[10.5px]"
                      style={{ color: deliveryStyle[e.delivery].color }}
                    >
                      {deliveryStyle[e.delivery].label}
                    </span>
                    {e.ruleName && (
                      <span className="font-mono text-[10.5px] text-faint">rule: {e.ruleName}</span>
                    )}
                    {e.link && (
                      <Link
                        href={e.link}
                        className="inline-flex items-center gap-1 font-mono text-[11px] hover:underline"
                        style={{ color: "var(--color-api)" }}
                      >
                        view evidence <ArrowUpRight className="h-3 w-3" />
                      </Link>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <div className="min-w-0 space-y-5">
          {/* rules */}
          <section className="min-w-0">
            <h2 className="mb-2 font-mono text-[11px] uppercase tracking-widest text-faint">
              rules · {active} active
            </h2>
            {rules.length === 0 ? (
              <div className="rounded-lg border border-line bg-surface p-5 text-center">
                <p className="font-mono text-[12.5px] text-mid">
                  no rules yet — a rule is a threshold over your own metrics or traces
                </p>
              </div>
            ) : (
              <div className="rounded-lg border border-line bg-surface">
                {rules.map((r) => (
                  <div key={r.id} className="border-b border-line/50 px-3.5 py-2.5 last:border-0">
                    <RuleControls rule={r} channels={channels} />
                    <p className="mt-0.5 font-mono text-[10.5px] text-mid">
                      {formatAlertCondition(r.condition)}
                    </p>
                    <p className="mt-0.5 font-mono text-[10px] text-faint">
                      → {r.channelName} ·{" "}
                      {r.lastTriggeredAt
                        ? `last triggered ${r.lastTriggeredAt.slice(0, 16).replace("T", " ")} UTC`
                        : "never triggered"}
                      {r.state === "firing" && (
                        <span className="ml-1.5" style={{ color: "var(--color-err)" }}>
                          · firing
                        </span>
                      )}
                    </p>
                    {r.runbook && (
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        <span className="flex items-center gap-1 rounded-[4px] border border-line bg-raised px-1.5 py-0.5 font-mono text-[9.5px] text-mid">
                          <BookOpen className="h-2.5 w-2.5 text-faint" />
                          {r.runbook}
                        </span>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* channels — where events deliver */}
          <ChannelManager channels={channels} />
        </div>
      </div>
    </div>
  );
}
