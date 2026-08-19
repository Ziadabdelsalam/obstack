"use client";

import { useState, useTransition } from "react";
import { Check, Copy, Plus, X } from "lucide-react";
import { apiKeys, ingest, members, modelPrices, usage } from "@/mock/workspace";
import type { Member } from "@/mock/workspace";
import { auditLog } from "@/mock/inbox";
import { complianceItems } from "@/mock/security";
import { SampleMark } from "@/components/ui/SampleMark";
import {
  cancelInvitation,
  inviteTeammate,
  issueKey,
  revokeKey,
} from "@/app/app/settings/actions";

/**
 * One settings surface, two data sources. `live` is the signed-in session's real
 * org, roster, invitations and keys, resolved by the page (`app/app/settings/
 * page.tsx`); `null` is the demo product, which has no accounts and no Postgres
 * and keeps rendering exactly what it always did (D125).
 *
 * The split is per TAB, not per page (D106): General, Members and API keys read
 * real rows in live mode, and the other four still render demo content and say
 * so with `SampleMark` — which is why `/app/settings` is registered in
 * `live-routes.ts` and no longer wears the route-wide sample badge. The tab
 * strip, the `Section` frame and the shown-once banner are shared by both
 * halves, so there is one definition of what this page looks like.
 */

const tabs = ["General", "Members", "API keys", "Billing & usage", "Data & ingest", "Audit log", "Compliance"] as const;
type Tab = (typeof tabs)[number];

/**
 * The four tabs that are still demo content in live mode, and WHY each one is —
 * the reason rides the badge's tooltip because it differs per tab (D106/D141).
 * A tab leaves this map when its data becomes real; nothing is half-wired.
 */
const SAMPLE_TABS: Partial<Record<Tab, string>> = {
  "Billing & usage": "demo billing state — metering and plans land in a later sprint",
  "Data & ingest": "demo ingest health and prices — the real ones land with price overrides",
  "Audit log": "demo audit events — obstack records none yet",
  Compliance: "demo compliance posture — obstack tracks none yet",
};

/**
 * What the live half renders. View shapes rather than the server's row types,
 * for one reason: every timestamp arrives as a STRING the page already formatted
 * in UTC. A `Date` formatted here would be formatted twice — once on the server
 * and once in whatever timezone the browser is in — and the two renders would
 * disagree. The page is the only place that knows the clock, so it is the only
 * place that reads one (`lib/format.ts`'s rule, applied to a date).
 */
export interface LiveMember {
  userId: string;
  name: string;
  email: string;
  role: string;
}

export interface LiveInvite {
  id: string;
  email: string;
  /** Built by `inviteLinkPath` on the server — one definition of the link (D143). */
  linkPath: string;
  expires: string;
}

export interface LiveKey {
  id: string;
  name: string;
  prefix: string;
  created: string;
  revoked: string | null;
}

export interface LiveSettings {
  orgName: string;
  workspaceId: string;
  members: LiveMember[];
  invites: LiveInvite[];
  keys: LiveKey[];
  /** `?error=` resolved to fixed copy by `settings/errors.ts` — never the code. */
  errorMessage: string | null;
}

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

/** One label/value row — the shape both Generals render. */
function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-line/60 py-2.5 last:border-0">
      <span className="font-mono text-[11px] uppercase tracking-widest text-faint">{label}</span>
      <span className="truncate font-mono text-[12.5px] text-mid">{value}</span>
    </div>
  );
}

/**
 * Read-only, and short on purpose (D148): the org's name and the workspace id
 * are the two facts the product HAS. There is no region column, no slug the
 * product shows and no rename — so none of them is displayed, rather than
 * displayed as a control that does nothing.
 */
function LiveGeneralTab({ live }: { live: LiveSettings }) {
  return (
    <Section title="workspace">
      <Field label="organization" value={live.orgName} />
      <Field label="workspace id" value={live.workspaceId} />
    </Section>
  );
}

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
          <Field key={r.k} label={r.k} value={r.v} />
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

/** The avatar both rosters render: up to two initials off a name or an address. */
function Initials({ name }: { name: string }) {
  return (
    <span className="flex h-7 w-7 items-center justify-center rounded-full bg-overlay font-mono text-[10px] text-mid">
      {name
        .split(/[\s@]/)
        .slice(0, 2)
        .map((p) => p[0]?.toUpperCase())
        .join("")}
    </span>
  );
}

/**
 * A pending invitation: the address it was sent to, when its link dies, and the
 * two things an inviter can do with it.
 *
 * The link is copied whole — `linkPath` comes from `inviteLinkPath` on the
 * server (one definition, D143) and the origin comes from the browser, because
 * the app cannot know from the inside which host a reader reached it on.
 */
function PendingInviteRow({ invite }: { invite: LiveInvite }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-line/60 py-2.5 last:border-0">
      <Initials name={invite.email} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] text-ink">{invite.email}</span>
        <span className="block font-mono text-[10.5px] text-faint">
          link expires {invite.expires}
        </span>
      </span>
      <button
        type="button"
        onClick={() => {
          navigator.clipboard
            .writeText(new URL(invite.linkPath, window.location.origin).toString())
            .catch(() => {});
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        className="flex items-center gap-1.5 rounded-md border border-line bg-raised px-2.5 py-1 text-[11.5px] text-mid hover:border-line-strong hover:text-ink"
      >
        {copied ? (
          <Check className="h-3.5 w-3.5" style={{ color: "var(--color-ok)" }} />
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )}
        {copied ? "copied" : "copy link"}
      </button>
      <form action={cancelInvitation}>
        <input type="hidden" name="invitationId" value={invite.id} />
        <button
          type="submit"
          className="font-mono text-[10.5px] text-faint hover:text-err"
          style={{ color: "var(--color-faint)" }}
        >
          cancel
        </button>
      </form>
    </div>
  );
}

/**
 * The roster, the open invitations, and the one form that adds to them (D148 —
 * there is no member-removal control here, and the endpoint that would back one
 * stays closed).
 *
 * Both sentences under the form are present tense and describe what the product
 * does today (D140). Membership is additive: an invitee gains a member row in
 * this organization and keeps resolving to their OWN workspace, because session
 * resolution is owner-pinned — so the copy says one workspace per account rather
 * than promising a switcher that does not exist.
 */
function LiveMembersTab({ live }: { live: LiveSettings }) {
  return (
    <>
      <Section title={`members · ${live.members.length}`}>
        {live.members.map((m) => (
          <div
            key={m.userId}
            className="flex flex-wrap items-center gap-3 border-b border-line/60 py-2.5 last:border-0"
          >
            <Initials name={m.name} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] text-ink">{m.name}</span>
              <span className="block font-mono text-[10.5px] text-faint">{m.email}</span>
            </span>
            <span className="font-mono text-[11px] text-mid">{m.role}</span>
          </div>
        ))}
      </Section>

      <Section title={`pending invites · ${live.invites.length}`}>
        {live.invites.length === 0 ? (
          <p className="py-1 text-[12.5px] text-faint">No open invitations.</p>
        ) : (
          live.invites.map((invite) => <PendingInviteRow key={invite.id} invite={invite} />)
        )}
      </Section>

      <Section title="invite a teammate">
        <form action={inviteTeammate} className="flex flex-wrap gap-2">
          <input
            name="email"
            type="email"
            required
            aria-label="Teammate's email address"
            placeholder="teammate@example.com"
            className="min-w-[220px] flex-1 rounded-md border border-line bg-raised px-3 py-1.5 text-[13px] text-ink placeholder:text-faint focus:border-line-strong focus:outline-none"
          />
          <button
            type="submit"
            className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12.5px] font-medium text-bg"
            style={{ background: "var(--color-ink)" }}
          >
            <Plus className="h-3.5 w-3.5" /> Invite
          </button>
        </form>
        <p className="mt-2.5 text-[12.5px] leading-relaxed text-mid">
          No email is sent — copy the invite link from the list above and send it yourself. It
          works only for an account with the address you invited.
        </p>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-mid">
          Someone who accepts joins {live.orgName} as a member. obstack shows one workspace per
          account, so they keep seeing their own.
        </p>
      </Section>
    </>
  );
}

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
            <Initials name={m.name} />
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

/**
 * The shown-once banner — one definition, both halves.
 *
 * In live mode the string in it is the only copy of that token that will ever
 * exist: `issueApiKey` stores the SHA-256 and drops the token (D98), so nothing
 * can read it back and no screen could offer to. That is why the banner has a
 * copy button and a dismiss, and why the list beside it shows a prefix.
 */
function IssuedKeyBanner({ token, onDismiss }: { token: string; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div
      className="mb-4 rounded-lg border p-3.5"
      style={{ borderColor: "color-mix(in srgb, var(--color-ok) 40%, var(--color-line))" }}
    >
      <div className="flex items-center justify-between">
        <p className="font-mono text-[10.5px] uppercase tracking-widest" style={{ color: "var(--color-ok)" }}>
          key created — copy it now, it won&apos;t be shown again
        </p>
        <button type="button" onClick={onDismiss} aria-label="Dismiss" className="text-faint hover:text-ink">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <code className="flex-1 overflow-x-auto rounded-md border border-line bg-bg px-2.5 py-1.5 font-mono text-[11.5px] text-ink">
          {token}
        </code>
        <button
          type="button"
          onClick={() => {
            navigator.clipboard.writeText(token).catch(() => {});
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
  );
}

/**
 * Issue, list, revoke — against real rows scoped to the session's workspace.
 *
 * `issueKey` is the one action on this page that ANSWERS instead of redirecting,
 * and this is where that shows: the token comes back in the response to the
 * submit and goes into client state, because a token in a `?token=` would be a
 * token in the browser's history, in a referrer and in every access log between
 * here and there. Everything else — revoke, invite, cancel — redirects, so its
 * result is whatever the server re-rendered.
 *
 * The keys the list shows include revoked ones: a key that stopped working is a
 * thing an operator needs to see, and ingest filters them out on its own side.
 */
function LiveKeysTab({ live }: { live: LiveSettings }) {
  const [issued, setIssued] = useState<string | null>(null);
  const [issuing, startIssuing] = useTransition();

  // `?.` because a REFUSED issue never returns: `issueKey` redirects with an
  // error code, and the value that reaches here while the router navigates is
  // not the one the type describes.
  const issue = (formData: FormData) =>
    startIssuing(async () => {
      const result = await issueKey(formData);
      setIssued(result?.token ?? null);
    });

  return (
    <>
      {issued && <IssuedKeyBanner token={issued} onDismiss={() => setIssued(null)} />}
      <Section title={`api keys · ${live.keys.length}`}>
        {live.keys.length === 0 && (
          <p className="py-1 text-[12.5px] text-faint">
            No keys yet. The one you create is shown once, here.
          </p>
        )}
        {live.keys.map((k) => (
          <div
            key={k.id}
            className="flex flex-wrap items-center gap-3 border-b border-line/60 py-2.5 last:border-0"
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] text-ink">{k.name}</span>
              <span className="block font-mono text-[11px] text-faint">{k.prefix}…</span>
            </span>
            <span className="w-24 text-right font-mono text-[10.5px] text-faint">{k.created}</span>
            {k.revoked ? (
              <span className="font-mono text-[10.5px] text-faint">revoked {k.revoked}</span>
            ) : (
              <form action={revokeKey}>
                <input type="hidden" name="keyId" value={k.id} />
                <button
                  type="submit"
                  className="font-mono text-[10.5px] text-faint hover:text-err"
                  style={{ color: "var(--color-faint)" }}
                >
                  revoke
                </button>
              </form>
            )}
          </div>
        ))}
        <form action={issue} className="mt-3 flex flex-wrap gap-2">
          <input
            name="name"
            required
            aria-label="Key name"
            placeholder="what this key is for, e.g. production ingest"
            className="min-w-[220px] flex-1 rounded-md border border-line bg-raised px-3 py-1.5 text-[13px] text-ink placeholder:text-faint focus:border-line-strong focus:outline-none"
          />
          <button
            type="submit"
            disabled={issuing}
            className="flex items-center gap-1.5 rounded-md border border-line bg-raised px-3 py-1.5 text-[12.5px] text-mid hover:border-line-strong hover:text-ink disabled:opacity-60"
          >
            <Plus className="h-3.5 w-3.5" /> {issuing ? "Creating…" : "Create key"}
          </button>
        </form>
      </Section>
      <p className="font-mono text-[10.5px] leading-relaxed text-faint">
        send it as <code>Authorization: Bearer &lt;token&gt;</code> — a revoked key stops being
        accepted within 30 seconds
      </p>
    </>
  );
}

/**
 * The demo's fabricated token, format-true against the one real shape (D144):
 * `ok_live_` + 64 hex characters, masked to the first twelve — the same string
 * the live tab would show, so the demo teaches nothing the product cannot do.
 */
const MOCK_TOKEN =
  "ok_live_3f9c1d8a45b27e60c1f4a9d2e83b57046c9ad1e2f70b84c53a6d9e1f0b2c74a8";

function KeysTab() {
  const [keys, setKeys] = useState(apiKeys);
  const [revealed, setRevealed] = useState<string | null>(null);

  const createKey = () => {
    setKeys((k) => [
      ...k,
      {
        name: `key-${k.length + 1}`,
        masked: `${MOCK_TOKEN.slice(0, 12)}…`,
        created: "just now",
      },
    ]);
    setRevealed(MOCK_TOKEN);
  };

  return (
    <>
      {revealed && <IssuedKeyBanner token={revealed} onDismiss={() => setRevealed(null)} />}
      <Section title={`api keys · ${keys.length}`}>
        {keys.map((k) => (
          <div key={k.name + k.created} className="flex flex-wrap items-center gap-3 border-b border-line/60 py-2.5 last:border-0">
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] text-ink">{k.name}</span>
              <span className="block font-mono text-[11px] text-faint">{k.masked}</span>
            </span>
            <span className="w-24 text-right font-mono text-[10.5px] text-faint">{k.created}</span>
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

export function SettingsSuite({ live }: { live: LiveSettings | null }) {
  const [tab, setTab] = useState<Tab>("General");
  return (
    <div className="mx-auto max-w-3xl px-5 py-6">
      <h1 className="font-display text-[19px] font-semibold text-ink">Settings</h1>
      {/* One page, one `?error=`, one place it is read — so the message stays put
          whichever tab the reader lands back on after a refused action. */}
      {live?.errorMessage && (
        <p
          role="alert"
          className="mt-2 text-[12.5px] leading-relaxed"
          style={{ color: "var(--color-err)" }}
        >
          {live.errorMessage}
        </p>
      )}
      <div className="mt-4 mb-5 flex flex-wrap gap-1 border-b border-line">
        {tabs.map((t) => {
          // Only in live mode: in the demo every surface is sample data and the
          // shell says so once, for the whole product (D125).
          const sample = live ? SAMPLE_TABS[t] : undefined;
          return (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13px] transition-colors ${
                tab === t ? "border-current text-ink" : "border-transparent text-faint hover:text-mid"
              }`}
              style={tab === t ? { borderBottomColor: "var(--color-api)" } : undefined}
            >
              {t}
              {sample && <SampleMark title={sample} />}
            </button>
          );
        })}
      </div>
      {tab === "General" && (live ? <LiveGeneralTab live={live} /> : <GeneralTab />)}
      {tab === "Members" && (live ? <LiveMembersTab live={live} /> : <MembersTab />)}
      {tab === "API keys" && (live ? <LiveKeysTab live={live} /> : <KeysTab />)}
      {tab === "Billing & usage" && <BillingTab />}
      {tab === "Data & ingest" && <IngestTab />}
      {tab === "Audit log" && <AuditTab />}
      {tab === "Compliance" && <ComplianceTab />}
    </div>
  );
}
