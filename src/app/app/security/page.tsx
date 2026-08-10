import Link from "next/link";
import { ArrowUpRight, ShieldCheck, ShieldAlert, Syringe, Drama, Wrench, Globe, KeyRound } from "lucide-react";
import { redactionRules, redactionStats, securityEvents, type SecurityEvent } from "@/mock/security";

const sevStyle = {
  high: { color: "var(--color-err)", label: "HIGH" },
  medium: { color: "var(--color-warn)", label: "MEDIUM" },
  low: { color: "var(--color-mid)", label: "LOW" },
} as const;

const typeMeta: Record<SecurityEvent["type"], { icon: typeof Syringe; label: string }> = {
  "prompt-injection": { icon: Syringe, label: "prompt injection" },
  jailbreak: { icon: Drama, label: "jailbreak" },
  "tool-anomaly": { icon: Wrench, label: "tool anomaly" },
  egress: { icon: Globe, label: "egress" },
  "key-anomaly": { icon: KeyRound, label: "key anomaly" },
};

const statusStyle = {
  blocked: { color: "var(--color-ok)", label: "BLOCKED" },
  flagged: { color: "var(--color-warn)", label: "FLAGGED" },
  investigating: { color: "var(--color-err)", label: "INVESTIGATING" },
} as const;

export default function SecurityPage() {
  return (
    <div className="px-5 py-4">
      <div className="mb-1 flex items-center gap-2.5">
        <h1 className="font-display text-[19px] font-semibold text-ink">Security</h1>
        <span
          className="flex items-center gap-1 rounded-[3px] px-1.5 py-px font-mono text-[9.5px] tracking-wide"
          style={{
            color: "var(--color-infra)",
            background: "color-mix(in srgb, var(--color-infra) 12%, transparent)",
          }}
        >
          <ShieldCheck className="h-3 w-3" /> AI RUNTIME
        </span>
      </div>
      <p className="mb-4 text-[12.5px] text-mid">
        obstack sees every prompt, tool call and egress — so it can catch what a WAF can&apos;t:
        attacks that arrive as language and misbehavior that looks like traffic.
      </p>

      {/* stat row */}
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { label: "threats · 7d", value: "5", delta: "2 blocked", good: true },
          { label: "injection attempts", value: "2", delta: "1 high-sev", good: false },
          { label: "redactions · 7d", value: "258", delta: "before storage", good: true },
          { label: "egress allowlist", value: "14 hosts", delta: "1 new blocked", good: true },
        ].map((s) => (
          <div key={s.label} className="rounded-lg border border-line bg-surface px-3.5 py-3">
            <p className="font-mono text-[10px] uppercase tracking-widest text-faint">{s.label}</p>
            <p className="mt-1 flex items-baseline gap-2">
              <span className="font-mono text-[20px] font-medium text-ink">{s.value}</span>
              <span
                className="font-mono text-[10.5px]"
                style={{ color: s.good ? "var(--color-ok)" : "var(--color-warn)" }}
              >
                {s.delta}
              </span>
            </p>
          </div>
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        {/* threat feed */}
        <section className="min-w-0">
          <h2 className="mb-2 font-mono text-[11px] uppercase tracking-widest text-faint">
            runtime detections · 7d
          </h2>
          <div className="space-y-2">
            {securityEvents.map((e) => {
              const sev = sevStyle[e.severity];
              const st = statusStyle[e.status];
              const T = typeMeta[e.type];
              const Icon = T.icon;
              return (
                <div
                  key={e.title}
                  className="rounded-lg border bg-surface p-3.5"
                  style={{
                    borderColor:
                      e.severity === "high"
                        ? "color-mix(in srgb, var(--color-err) 40%, var(--color-line))"
                        : "var(--color-line)",
                  }}
                >
                  <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
                    <span
                      className="rounded-[3px] px-1.5 py-px font-mono text-[9.5px] tracking-wide"
                      style={{ color: sev.color, background: `color-mix(in srgb, ${sev.color} 12%, transparent)` }}
                    >
                      {sev.label}
                    </span>
                    <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-faint">
                      <Icon className="h-3.5 w-3.5" /> {T.label}
                    </span>
                    <span className="ml-auto font-mono text-[10.5px] text-faint">{e.time}</span>
                    <span
                      className="rounded-[3px] px-1.5 py-px font-mono text-[9.5px] tracking-wide"
                      style={{ color: st.color, background: `color-mix(in srgb, ${st.color} 12%, transparent)` }}
                    >
                      {st.label}
                    </span>
                  </div>
                  <h3 className="mt-1.5 text-[13.5px] font-medium text-ink">{e.title}</h3>
                  <p className="mt-1 text-[12.5px] leading-relaxed text-mid">{e.detail}</p>
                  {e.evidence && (
                    <p
                      className="mt-2 rounded-md border px-2.5 py-1.5 font-mono text-[11px] leading-relaxed"
                      style={{
                        color: "var(--color-warn)",
                        borderColor: "color-mix(in srgb, var(--color-warn) 30%, var(--color-line))",
                        background: "color-mix(in srgb, var(--color-warn) 5%, transparent)",
                      }}
                    >
                      {e.evidence}
                    </p>
                  )}
                  {e.link && (
                    <Link
                      href={e.link.href}
                      className="mt-1.5 inline-flex items-center gap-1 font-mono text-[11px] hover:underline"
                      style={{ color: "var(--color-api)" }}
                    >
                      {e.link.label} <ArrowUpRight className="h-3 w-3" />
                    </Link>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        {/* redaction */}
        <section className="min-w-0 space-y-4">
          <div className="rounded-lg border border-line bg-surface">
            <div className="flex items-center justify-between border-b border-line px-3.5 py-2.5">
              <h2 className="font-mono text-[11px] uppercase tracking-widest text-faint">
                pii & secret redaction · {redactionStats.window}
              </h2>
              <ShieldAlert className="h-3.5 w-3.5 text-faint" />
            </div>
            <div className="px-3.5 py-3">
              {redactionStats.totals.map((t) => (
                <div key={t.label} className="flex items-baseline justify-between border-b border-line/50 py-1.5 last:border-0">
                  <span className="text-[12.5px] text-mid">{t.label}</span>
                  <span className="font-mono text-[13px] text-ink">{t.count}</span>
                </div>
              ))}
              <p className="mt-2 font-mono text-[10px] leading-relaxed" style={{ color: "var(--color-ok)" }}>
                {redactionStats.note}
              </p>
            </div>
          </div>

          <div className="rounded-lg border border-line bg-surface">
            <div className="border-b border-line px-3.5 py-2.5">
              <h2 className="font-mono text-[11px] uppercase tracking-widest text-faint">
                active rules · {redactionRules.length}
              </h2>
            </div>
            <div className="px-3.5 py-2">
              {redactionRules.map((r) => (
                <div key={r.rule} className="border-b border-line/50 py-2 last:border-0">
                  <p className="text-[12.5px] font-medium text-ink">{r.rule}</p>
                  <p className="font-mono text-[10px] text-faint">
                    {r.scope} · <span className="text-mid">{r.mode}</span>
                  </p>
                </div>
              ))}
            </div>
          </div>

          <p className="font-mono text-[10px] leading-relaxed text-faint">
            compliance posture (residency, retention, DSR, SOC 2) lives in{" "}
            <Link href="/app/settings" className="underline decoration-line underline-offset-2 hover:text-mid">
              Settings → Compliance
            </Link>
          </p>
        </section>
      </div>
    </div>
  );
}
