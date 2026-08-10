"use client";

import { useState } from "react";
import { Check, Copy, Plus, X } from "lucide-react";
import { apiKeys, ingest, members, modelPrices, usage } from "@/mock/workspace";
import type { Member } from "@/mock/workspace";
import { auditLog } from "@/mock/inbox";
import { complianceItems } from "@/mock/security";

const tabs = ["General", "Members", "API keys", "Billing & usage", "Data & ingest", "Audit log", "Compliance"] as const;
type Tab = (typeof tabs)[number];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-5 rounded-lg border border-line bg-surface">
      <div className="border-b border-line px-4 py-2.5">
        <h2 className="font-mono text-[11px] uppercase tracking-widest text-faint">{title}</h2>
      </div>
      <div className="px-4 py-3.5">{children}</div>
    </section>
  );
}

function Meter({ label, used, quota, unit }: { label: string; used: number; quota: number; unit?: string }) {
  const pct = Math.min((used / quota) * 100, 100);
  const hot = pct >= 75;
  return (
    <div className="mb-3.5 last:mb-0">
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-[12.5px] text-mid">{label}</span>
        <span className="font-mono text-[11.5px] text-ink">
          {used.toLocaleString()} / {quota.toLocaleString()}
          {unit ? ` ${unit}` : ""}{" "}
          <span style={{ color: hot ? "var(--color-warn)" : "var(--color-faint)" }}>
            ({pct.toFixed(0)}%)
          </span>
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-overlay">
        <div
          className="h-full rounded-full"
          style={{
            width: `${pct}%`,
            background: hot ? "var(--color-warn)" : "var(--color-api)",
          }}
        />
      </div>
    </div>
  );
}

/* ---------------- General ---------------- */

function GeneralTab() {
  return (
    <>
      <Section title="workspace">
        {[
          { k: "name", v: "Loopwork" },
          { k: "slug", v: "loopwork-prod" },
          { k: "data region", v: "eu-central (Frankfurt)" },
          { k: "created", v: "May 12, 2026" },
          { k: "deployment", v: "obstack cloud · self-hosted available on Enterprise" },
        ].map((r) => (
          <div
            key={r.k}
            className="flex items-center justify-between border-b border-line/60 py-2.5 last:border-0"
          >
            <span className="font-mono text-[11px] uppercase tracking-widest text-faint">{r.k}</span>
            <span className="font-mono text-[12.5px] text-mid">{r.v}</span>
          </div>
        ))}
      </Section>
      <Section title="danger zone">
        <div className="flex items-center justify-between gap-4">
          <p className="text-[12.5px] leading-relaxed text-mid">
            Deleting the workspace erases all telemetry, keys and members after a 7-day grace period.
          </p>
          <button
            type="button"
            title="Disabled in demo"
            className="shrink-0 cursor-not-allowed rounded-md border px-3 py-1.5 text-[12.5px] opacity-60"
            style={{
              color: "var(--color-err)",
              borderColor: "color-mix(in srgb, var(--color-err) 40%, var(--color-line))",
            }}
          >
            Delete workspace
          </button>
        </div>
      </Section>
    </>
  );
}

/* ---------------- Members ---------------- */

function MembersTab() {
  const [list, setList] = useState<Member[]>(members);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "member">("member");

  const invite = () => {
    if (!email.includes("@")) return;
    setList((l) => [...l, { name: email, email, role, joined: "—", pending: true }]);
    setEmail("");
  };

  return (
    <>
      <Section title={`members · ${list.filter((m) => !m.pending).length} active`}>
        {list.map((m) => (
          <div
            key={m.email}
            className="flex flex-wrap items-center gap-3 border-b border-line/60 py-2.5 last:border-0"
          >
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-overlay font-mono text-[10px] text-mid">
              {m.name
                .split(/[\s@]/)
                .slice(0, 2)
                .map((p) => p[0]?.toUpperCase())
                .join("")}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] text-ink">{m.name}</span>
              <span className="block font-mono text-[10.5px] text-faint">{m.email}</span>
            </span>
            {m.pending && (
              <span className="rounded-[3px] bg-overlay px-1.5 py-px font-mono text-[9.5px] tracking-wide text-faint">
                PENDING
              </span>
            )}
            <span className="w-16 font-mono text-[11px] text-mid">{m.role}</span>
            <span className="w-20 text-right font-mono text-[10.5px] text-faint">{m.joined}</span>
          </div>
        ))}
      </Section>
      <Section title="invite">
        <div className="flex flex-wrap gap-2">
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="teammate@loopwork.ai"
            className="min-w-[220px] flex-1 rounded-md border border-line bg-raised px-3 py-1.5 text-[13px] text-ink placeholder:text-faint focus:border-line-strong focus:outline-none"
          />
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as "admin" | "member")}
            aria-label="Role"
            className="rounded-md border border-line bg-raised px-2.5 py-1.5 text-[12.5px] text-mid focus:outline-none"
          >
            <option value="member">member</option>
            <option value="admin">admin</option>
          </select>
          <button
            type="button"
            onClick={invite}
            className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12.5px] font-medium text-bg"
            style={{ background: "var(--color-ink)" }}
          >
            <Plus className="h-3.5 w-3.5" /> Invite
          </button>
        </div>
        <p className="mt-2 font-mono text-[10.5px] text-faint">
          free plan includes 2 seats — additional invites prompt an upgrade on accept
        </p>
      </Section>
    </>
  );
}

/* ---------------- API keys ---------------- */

function KeysTab() {
  const [keys, setKeys] = useState(apiKeys);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const createKey = () => {
    const fresh = "ob_live_k3d9x1mv84qz7wte2ncy5rhj6bfa0pgs";
    setKeys((k) => [
      ...k,
      { name: `key-${k.length + 1}`, masked: "ob_live_k3d9…0pgs", created: "just now", lastUsed: "never", scope: "ingest" },
    ]);
    setRevealed(fresh);
  };

  return (
    <>
      {revealed && (
        <div
          className="mb-4 rounded-lg border p-3.5"
          style={{ borderColor: "color-mix(in srgb, var(--color-ok) 40%, var(--color-line))" }}
        >
          <div className="flex items-center justify-between">
            <p className="font-mono text-[10.5px] uppercase tracking-widest" style={{ color: "var(--color-ok)" }}>
              key created — copy it now, it won&apos;t be shown again
            </p>
            <button type="button" onClick={() => setRevealed(null)} aria-label="Dismiss" className="text-faint hover:text-ink">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <code className="flex-1 overflow-x-auto rounded-md border border-line bg-bg px-2.5 py-1.5 font-mono text-[11.5px] text-ink">
              {revealed}
            </code>
            <button
              type="button"
              onClick={() => {
                navigator.clipboard.writeText(revealed).catch(() => {});
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
              aria-label="Copy key"
              className="rounded-md border border-line bg-raised p-2 text-mid hover:text-ink"
            >
              {copied ? <Check className="h-3.5 w-3.5" style={{ color: "var(--color-ok)" }} /> : <Copy className="h-3.5 w-3.5" />}
            </button>
          </div>
        </div>
      )}
      <Section title={`api keys · ${keys.length}`}>
        {keys.map((k) => (
          <div key={k.name + k.created} className="flex flex-wrap items-center gap-3 border-b border-line/60 py-2.5 last:border-0">
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] text-ink">{k.name}</span>
              <span className="block font-mono text-[11px] text-faint">{k.masked}</span>
            </span>
            <span
              className="rounded-[3px] px-1.5 py-px font-mono text-[9.5px] tracking-wide"
              style={{
                color: "var(--color-api)",
                background: "color-mix(in srgb, var(--color-api) 12%, transparent)",
              }}
            >
              {k.scope.toUpperCase()}
            </span>
            <span className="w-24 text-right font-mono text-[10.5px] text-faint">{k.created}</span>
            <span className="w-16 text-right font-mono text-[10.5px] text-mid">{k.lastUsed}</span>
            <button type="button" className="font-mono text-[10.5px] text-faint hover:text-err" style={{ color: "var(--color-faint)" }}>
              revoke
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={createKey}
          className="mt-3 flex items-center gap-1.5 rounded-md border border-line bg-raised px-3 py-1.5 text-[12.5px] text-mid hover:border-line-strong hover:text-ink"
        >
          <Plus className="h-3.5 w-3.5" /> Create key
        </button>
      </Section>
    </>
  );
}

/* ---------------- Billing ---------------- */

function BillingTab() {
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  return (
    <>
      <Section title="plan">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-[15px] font-semibold text-ink">{usage.plan}</p>
            <p className="mt-0.5 font-mono text-[11px] text-faint">
              {usage.retentionDays}-day retention · resets {usage.resetsOn}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setUpgradeOpen(true)}
            className="rounded-md px-3.5 py-2 text-[13px] font-medium text-bg"
            style={{ background: "var(--color-ink)" }}
          >
            Upgrade to Pro — $49/mo
          </button>
        </div>
      </Section>
      <Section title="usage this cycle">
        <Meter label="events (spans + log records)" used={usage.events.used} quota={usage.events.quota} />
        <Meter label="Explain runs" used={usage.explainRuns.used} quota={usage.explainRuns.quota} />
        <Meter label="seats" used={usage.seats.used} quota={usage.seats.quota} />
        <p className="mt-2 font-mono text-[10.5px] leading-relaxed text-faint">
          at quota, ingestion degrades to sampled mode (never a hard cut) — see Data &amp; ingest
        </p>
      </Section>
      <Section title="invoices">
        <p className="py-2 text-center text-[12.5px] text-faint">
          No invoices yet — the Free plan doesn&apos;t bill. Upgrading creates your first invoice.
        </p>
      </Section>

      {upgradeOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setUpgradeOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-label="Upgrade to Pro"
        >
          <div
            className="w-full max-w-md rounded-xl border border-line-strong bg-surface p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="font-display text-[18px] font-semibold text-ink">Upgrade to Pro</h3>
            <ul className="mt-3 space-y-2">
              {[
                "1M events/mo included, then $1.50 per 100k",
                "30-day retention",
                "Unlimited seats",
                "200 Explain runs/mo",
              ].map((i) => (
                <li key={i} className="flex items-start gap-2 text-[13px] text-mid">
                  <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" style={{ color: "var(--color-ok)" }} />
                  {i}
                </li>
              ))}
            </ul>
            <button
              type="button"
              title="Demo — checkout not wired"
              className="mt-4 w-full cursor-not-allowed rounded-md py-2.5 text-[13.5px] font-medium text-bg opacity-80"
              style={{ background: "var(--color-ink)" }}
            >
              Continue to Stripe checkout →
            </button>
            <button
              type="button"
              onClick={() => setUpgradeOpen(false)}
              className="mt-2 w-full rounded-md border border-line py-2 text-[12.5px] text-mid hover:text-ink"
            >
              Not now
            </button>
          </div>
        </div>
      )}
    </>
  );
}

/* ---------------- Data & ingest ---------------- */

function IngestTab() {
  return (
    <>
      <Section title="ingest health · last 24h">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-widest text-faint">events received</p>
            <p className="mt-0.5 font-mono text-[20px] text-ink">{ingest.eventsLast24h.toLocaleString()}</p>
          </div>
          <div>
            <p className="font-mono text-[10px] uppercase tracking-widest text-faint">dropped (malformed)</p>
            <p className="mt-0.5 font-mono text-[20px]" style={{ color: ingest.droppedLast24h ? "var(--color-warn)" : "var(--color-ink)" }}>
              {ingest.droppedLast24h}
            </p>
          </div>
        </div>
        <div className="mt-3 rounded-md border border-line bg-raised">
          {ingest.droppedBySource.map((d) => (
            <div key={d.source} className="flex items-center justify-between border-b border-line/60 px-3 py-2 last:border-0">
              <span className="text-[12.5px] text-mid">{d.source}</span>
              <span className="font-mono text-[11px] text-faint">
                {d.count} · {d.reason}
              </span>
            </div>
          ))}
        </div>
        <p className="mt-2 font-mono text-[10.5px] leading-relaxed text-faint">
          malformed data is dropped and counted — ingest never 500s back at your services
        </p>
      </Section>

      <Section title="sampling & degradation">
        <div className="flex items-center justify-between">
          <span className="text-[12.5px] text-mid">sampling rate</span>
          <span className="font-mono text-[12.5px] text-ink">{ingest.samplingRate}%</span>
        </div>
        <div className="mt-2 flex items-center justify-between">
          <span className="text-[12.5px] text-mid">degraded mode</span>
          <span className="font-mono text-[12.5px]" style={{ color: "var(--color-ok)" }}>
            off
          </span>
        </div>
        <p className="mt-2 font-mono text-[10.5px] leading-relaxed text-faint">
          at 100% of quota, ingestion automatically samples down instead of dropping everything; a
          banner appears in the app while degraded
        </p>
      </Section>

      <Section title="model pricing · cost attribution">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-line text-left font-mono text-[10px] uppercase tracking-widest text-faint">
              <th className="pb-1.5 font-medium">model</th>
              <th className="pb-1.5 text-right font-medium">input $/M</th>
              <th className="pb-1.5 text-right font-medium">output $/M</th>
              <th className="pb-1.5 text-right font-medium">source</th>
            </tr>
          </thead>
          <tbody>
            {modelPrices.map((m) => (
              <tr key={m.model} className="border-b border-line/50 last:border-0">
                <td className="py-2 font-mono text-[11.5px] text-mid">{m.model}</td>
                <td className="py-2 text-right font-mono text-[11.5px] text-mid">${m.inputPerM.toFixed(2)}</td>
                <td className="py-2 text-right font-mono text-[11.5px] text-mid">${m.outputPerM.toFixed(2)}</td>
                <td className="py-2 text-right">
                  <span
                    className="rounded-[3px] px-1.5 py-px font-mono text-[9.5px] tracking-wide"
                    style={
                      m.source === "custom"
                        ? { color: "var(--color-agent)", background: "color-mix(in srgb, var(--color-agent) 12%, transparent)" }
                        : { color: "var(--color-faint)", background: "var(--color-overlay)" }
                    }
                  >
                    {m.source.toUpperCase()}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 font-mono text-[10.5px] text-faint">
          cost is computed at ingest from tokens × these rates — override any row for custom models
        </p>
      </Section>

      <Section title="retention">
        <div className="flex items-center justify-between">
          <span className="text-[12.5px] text-mid">telemetry retention (ClickHouse TTL)</span>
          <span className="font-mono text-[12.5px] text-ink">{usage.retentionDays} days · Free tier</span>
        </div>
      </Section>
    </>
  );
}

/* ---------------- Audit log ---------------- */

function AuditTab() {
  return (
    <Section title={`audit log · last ${auditLog.length} events`}>
      {auditLog.map((e, i) => (
        <div key={i} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b border-line/60 py-2.5 last:border-0">
          <span className="w-[150px] shrink-0 truncate font-mono text-[11px] text-mid">{e.who}</span>
          <span className="min-w-0 flex-1 text-[12.5px] text-ink">{e.action}</span>
          <span className="font-mono text-[10.5px] text-faint">{e.when}</span>
          <span className="w-[100px] text-right font-mono text-[10px] text-faint">{e.ip}</span>
        </div>
      ))}
      <p className="mt-3 font-mono text-[10.5px] text-faint">
        90-day audit retention · exportable as JSON on Enterprise
      </p>
    </Section>
  );
}

/* ---------------- Compliance ---------------- */

function ComplianceTab() {
  const [dsrEmail, setDsrEmail] = useState("");
  const [dsrQueued, setDsrQueued] = useState<string | null>(null);
  return (
    <>
      <Section title="posture">
        {complianceItems.map((c) => (
          <div key={c.control} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b border-line/60 py-2.5 last:border-0">
            <span
              className="w-14 shrink-0 rounded-[3px] px-1.5 py-px text-center font-mono text-[9px] tracking-wide"
              style={
                c.status === "ok"
                  ? { color: "var(--color-ok)", background: "color-mix(in srgb, var(--color-ok) 12%, transparent)" }
                  : { color: "var(--color-warn)", background: "color-mix(in srgb, var(--color-warn) 12%, transparent)" }
              }
            >
              {c.status === "ok" ? "OK" : "PENDING"}
            </span>
            <span className="w-[160px] shrink-0 text-[13px] font-medium text-ink">{c.control}</span>
            <span className="min-w-0 flex-1 text-[12px] leading-relaxed text-mid">{c.detail}</span>
          </div>
        ))}
      </Section>

      <Section title="data subject request (gdpr)">
        <p className="text-[12.5px] leading-relaxed text-mid">
          Purge every trace, log line and derived record attributed to an end user — completes
          within 72h, verified and audit-logged.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <input
            value={dsrEmail}
            onChange={(e) => setDsrEmail(e.target.value)}
            placeholder="end-user id or email, e.g. ops@meridianlabs.io"
            className="min-w-[240px] flex-1 rounded-md border border-line bg-raised px-3 py-1.5 font-mono text-[12px] text-ink placeholder:text-faint focus:border-line-strong focus:outline-none"
          />
          <button
            type="button"
            onClick={() => {
              if (dsrEmail.trim()) {
                setDsrQueued(dsrEmail.trim());
                setDsrEmail("");
              }
            }}
            className="rounded-md px-3.5 py-1.5 text-[12.5px] font-medium text-bg"
            style={{ background: "var(--color-ink)" }}
          >
            Queue deletion
          </button>
        </div>
        {dsrQueued && (
          <p className="mt-2 flex items-center gap-1.5 font-mono text-[11px]" style={{ color: "var(--color-ok)" }}>
            <Check className="h-3.5 w-3.5" /> deletion queued for {dsrQueued} — completion by{" "}
            {"Aug 13"} · tracked in audit log
          </p>
        )}
      </Section>
    </>
  );
}

/* ---------------- Suite ---------------- */

export function SettingsSuite() {
  const [tab, setTab] = useState<Tab>("General");
  return (
    <div className="mx-auto max-w-3xl px-5 py-6">
      <h1 className="font-display text-[19px] font-semibold text-ink">Settings</h1>
      <div className="mt-4 mb-5 flex flex-wrap gap-1 border-b border-line">
        {tabs.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`-mb-px border-b-2 px-3 py-2 text-[13px] transition-colors ${
              tab === t ? "border-current text-ink" : "border-transparent text-faint hover:text-mid"
            }`}
            style={tab === t ? { borderBottomColor: "var(--color-api)" } : undefined}
          >
            {t}
          </button>
        ))}
      </div>
      {tab === "General" && <GeneralTab />}
      {tab === "Members" && <MembersTab />}
      {tab === "API keys" && <KeysTab />}
      {tab === "Billing & usage" && <BillingTab />}
      {tab === "Data & ingest" && <IngestTab />}
      {tab === "Audit log" && <AuditTab />}
      {tab === "Compliance" && <ComplianceTab />}
    </div>
  );
}
