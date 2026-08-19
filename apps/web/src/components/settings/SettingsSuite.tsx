"use client";

import { useEffect, useState, useTransition } from "react";
import { Check, Copy, Plus, X } from "lucide-react";
import { apiKeys, ingest, members, modelPrices, usage } from "@/mock/workspace";
import type { Member } from "@/mock/workspace";
import { auditLog } from "@/mock/inbox";
import { complianceItems } from "@/mock/security";
import { SampleMark } from "@/components/ui/SampleMark";
import {
  cancelInvitation,
  deleteOverride,
  inviteTeammate,
  issueKey,
  loadIngestHealth,
  revokeKey,
  saveOverride,
} from "@/app/app/settings/actions";
import { startCheckout } from "@/app/app/settings/billing-actions";

/**
 * One settings surface, two data sources. `live` is the signed-in session's real
 * org, roster, invitations and keys, resolved by the page (`app/app/settings/
 * page.tsx`); `null` is the demo product, which has no accounts and no Postgres
 * and keeps rendering exactly what it always did (D125).
 *
 * The split is per TAB, not per page (D106): General, Members, API keys,
 * Billing & usage and Data & ingest read real rows in live mode, and the two
 * that are left still render demo content and say so with `SampleMark` — which
 * is why `/app/settings` is registered in `live-routes.ts` and no longer wears
 * the route-wide sample badge. The tab strip, the `Section` frame and the
 * shown-once banner are shared by both halves, so there is one definition of
 * what this page looks like.
 *
 * Four of the five live tabs are fed by the page's props. Data & ingest is not:
 * it loads itself when it is opened (`loadIngestHealth`), because its rows are
 * the only ones on this page nobody looking at General, Members or Billing
 * needs — and its writes answer with the new list rather than a redirect, so a
 * refused override keeps the form the operator typed into.
 */

const tabs = ["General", "Members", "API keys", "Billing & usage", "Data & ingest", "Audit log", "Compliance"] as const;
type Tab = (typeof tabs)[number];

/**
 * The tabs that are still demo content in live mode, and WHY each one is — the
 * reason rides the badge's tooltip because it differs per tab (D106/D141). A tab
 * leaves this map when its data becomes real; nothing is half-wired. Billing &
 * usage left it here: the meter, the plan and the retention line are read from
 * Postgres now (D106). Data & ingest left with it: per-key health, the error
 * count and the price overrides are rows (D141), and the one number it does not
 * have — the sampling rate — is stated qualitatively rather than restated in a
 * second language (D165).
 */
const SAMPLE_TABS: Partial<Record<Tab, string>> = {
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

/**
 * A row of the plan catalog. Every number in it is a `plans` column read through
 * `server/usage.ts` (D163) — quota, retention and price are defined in Postgres
 * and nowhere in TypeScript, so this interface carries values and never
 * defaults. `upgrade` is the server's answer to "can this workspace buy this
 * plan", not the client's: a plan id posted from here is validated against the
 * same catalog before a checkout exists (D148).
 */
export interface LivePlan {
  id: string;
  name: string;
  priceUsdMonth: number;
  eventQuota: number;
  retentionDays: number;
  upgrade: boolean;
}

/**
 * The billing tab's whole state, from the one usage definition (D171): the same
 * `getUsage` call feeds the shell's usage banner, so the percentage up there and
 * the meter down here cannot drift apart.
 *
 * `asOf` is null when the workspace has never metered — "no events yet" rather
 * than a date — and `checkout` is the enumerated outcome of a return from Polar,
 * never text from the URL (D121).
 */
export interface LiveBilling {
  planName: string;
  eventsUsed: number;
  eventQuota: number;
  retentionDays: number;
  /** The billing period, a UTC calendar month, formatted by the page. */
  periodStart: string;
  asOf: string | null;
  plans: LivePlan[];
  checkout: "applied" | "pending" | "failed" | null;
}

export interface LiveSettings {
  orgName: string;
  workspaceId: string;
  members: LiveMember[];
  invites: LiveInvite[];
  keys: LiveKey[];
  billing: LiveBilling;
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

/**
 * What came back from a checkout. Three outcomes, fixed copy, chosen by the
 * server from `reconcileCheckout`'s result — the `?checkout=` value itself is an
 * id someone could have typed, so it is read, reconciled and discarded, and none
 * of it reaches the screen (D121).
 *
 * "pending" is its own sentence rather than a failure: a customer who closed the
 * payment tab is not an error, and telling them their upgrade failed when Polar
 * may still complete it would be a lie the webhook then contradicts (D169 — the
 * reconciler runs either way).
 *
 * "failed" claims nothing about the money. A checkout can reach this branch
 * having actually been PAID — succeeded but missing its plan id is a refusal
 * (`reconcile.ts`) — so "nothing was charged" would be a sentence we cannot
 * know is true, said to someone who just paid. What we do know is what our own
 * row says and that the webhook reconciles the same checkout independently.
 */
const CHECKOUT_NOTICES = {
  applied: "Your plan is updated — the meter below is measured against it now.",
  pending: "That checkout isn't paid yet. If you complete it, this page updates on its own.",
  failed:
    "We couldn't confirm that checkout, so your plan is unchanged for now. If the payment went through, it applies as soon as Polar confirms it.",
} as const;

/**
 * The tab, from `server/usage.ts` and the plan catalog — the D171 one-definition
 * surface. What the meter shows is what the shell's banner shows and what the
 * reporter sends to Polar, because all three read the one function.
 *
 * There is no invoice list: Polar is the merchant of record (D110), so the
 * product computes no tax and holds no invoice — a panel here would either be
 * empty forever or be a second copy of Polar's. And there is no price anywhere
 * that is not a `plans` row: quota, retention and cost are Postgres columns
 * (D163), so this component formats numbers it is given and defines none.
 */
function LiveBillingTab({ live }: { live: LiveSettings }) {
  const { billing } = live;
  const overQuota = billing.eventsUsed >= billing.eventQuota;
  const upgrades = billing.plans.filter((plan) => plan.upgrade);

  return (
    <>
      {billing.checkout && (
        <p
          role="status"
          className="mb-4 rounded-lg border border-line bg-surface px-4 py-2.5 text-[12.5px] leading-relaxed text-mid"
        >
          {CHECKOUT_NOTICES[billing.checkout]}
        </p>
      )}

      <Section title="plan">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <p className="text-[15px] font-semibold text-ink">{billing.planName}</p>
          <p className="font-mono text-[11px] text-faint">
            billing period {billing.periodStart} · UTC calendar month
          </p>
        </div>
      </Section>

      <Section title="usage this period">
        <Meter
          label="events (spans + log records)"
          used={billing.eventsUsed}
          quota={billing.eventQuota}
        />
        <p className="mt-2 font-mono text-[10.5px] leading-relaxed text-faint">
          {billing.asOf ? `as of ${billing.asOf}` : "no events yet this period"}
        </p>
        <p className="mt-1 font-mono text-[10.5px] leading-relaxed text-faint">
          {overQuota
            ? "over quota — ingestion is sampling now: a sampled-out trace is dropped whole, and every trace that survives stays complete"
            : "at quota, ingestion degrades to sampled traces instead of a hard cut — nothing is truncated mid-trace"}
        </p>
      </Section>

      <Section title="retention">
        <div className="flex items-center justify-between">
          <span className="text-[12.5px] text-mid">telemetry retention</span>
          <span className="font-mono text-[12.5px] text-ink">
            {billing.retentionDays} days · {billing.planName}
          </span>
        </div>
        {/* D105, and deliberately not a deletion claim: retention is sold as an
            entitlement and the enforcement status is stated in the same breath,
            because the product currently over-delivers and saying so is the
            honest version of both facts. */}
        <p className="mt-2 text-[12.5px] leading-relaxed text-mid">
          TTL enforcement lands at M4 and data is currently retained without tier cutoff.
        </p>
      </Section>

      {upgrades.length > 0 && (
        <Section title="change plan">
          {upgrades.map((plan) => (
            <div
              key={plan.id}
              className="flex flex-wrap items-center gap-3 border-b border-line/60 py-2.5 last:border-0"
            >
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] text-ink">{plan.name}</span>
                <span className="block font-mono text-[10.5px] text-faint">
                  {plan.eventQuota.toLocaleString()} events/mo · {plan.retentionDays}-day retention
                </span>
              </span>
              <span className="font-mono text-[12.5px] text-mid">${plan.priceUsdMonth}/mo</span>
              {/* The form names a PLAN and nothing else: the workspace comes from
                  the session on the server and the price comes from Polar's own
                  checkout, so neither is forgeable from here (D148/D110). */}
              <form action={startCheckout}>
                <input type="hidden" name="planId" value={plan.id} />
                <button
                  type="submit"
                  className="rounded-md px-3 py-1.5 text-[12.5px] font-medium text-bg"
                  style={{ background: "var(--color-ink)" }}
                >
                  Upgrade to {plan.name}
                </button>
              </form>
            </div>
          ))}
          <p className="mt-2.5 font-mono text-[10.5px] leading-relaxed text-faint">
            checkout, payment and invoices are handled by Polar — obstack stores which plan you are
            on, never a card
          </p>
        </Section>
      )}
    </>
  );
}

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

/**
 * One key's health row (D100), as the tab lists it. `errors` is decode plus
 * unsupported — receive-path errors — and `sampled` is the quota drops, kept a
 * separate number on purpose: a sampled-out trace is the degradation the plan
 * bought, and adding it to an error count would tell an operator their exporter
 * is broken while it is working exactly as designed.
 */
export interface LiveKeyHealth {
  keyId: string;
  name: string;
  prefix: string;
  revoked: boolean;
  accepted: number;
  errors: number;
  sampled: number;
  /** Formatted on the server, like every other timestamp on this page. */
  lastEvent: string | null;
}

/** One pricing override (D108), the D9 row shape with a workspace on it. */
export interface LiveOverride {
  id: string;
  match: string;
  inputPerMTok: number;
  outputPerMTok: number;
  updated: string;
}

/**
 * The whole Data & ingest tab, from `server/ingest-health.ts`. The totals are
 * the server's sums of the same rows listed beside them — the tab adds nothing
 * up itself, so the summary and the list cannot disagree.
 *
 * `asOf` is the freshest health row's `updated_at` (D162) and is null when no
 * key has ever carried an event: "no events yet" rather than a dated zero.
 */
export interface LiveIngest {
  keys: LiveKeyHealth[];
  accepted: number;
  receiveErrors: number;
  droppedQuota: number;
  asOf: string | null;
  overrides: LiveOverride[];
  /** D164(f)'s cap, carried so the form states the number the server enforces. */
  overrideMax: number;
  /** The embedded price list's date and size (D29), read from the file ingest embeds. */
  pricesAsOf: string;
  pricedModels: number;
}

/**
 * What an override write answers with: the list as it now stands, and a reason
 * if it refused. Both, always — a refusal still returns the current list, so a
 * failed submit never blanks the table under the form.
 */
export interface IngestFormResult {
  ingest: LiveIngest;
  error: string | null;
}

/**
 * The one thing the tab says for itself. Every other sentence it shows comes
 * from the server; this one is what is left when the server said nothing at
 * all, and it claims nothing about the ingestion — a settings page that could
 * not read a row knows nothing about whether spans are arriving.
 */
const INGEST_UNREACHABLE =
  "Couldn't read these rows just now. Nothing about your ingestion changed — reload to try again.";

/** A number with its label, the shape the health summary repeats three times. */
function Stat({ label, value, warn }: { label: string; value: number; warn?: boolean }) {
  return (
    <div>
      <p className="font-mono text-[10px] uppercase tracking-widest text-faint">{label}</p>
      <p
        className="mt-0.5 font-mono text-[20px]"
        style={{ color: warn && value > 0 ? "var(--color-warn)" : "var(--color-ink)" }}
      >
        {value.toLocaleString()}
      </p>
    </div>
  );
}

/**
 * The real ingest surface: what each key has carried, what was refused, what
 * was sampled away, and the prices this workspace overrides.
 *
 * It loads itself. The health rows and the override list are the only data on
 * this page that no other tab needs, and a Server Function called from
 * `useEffect` is the documented way for a client component to fetch them
 * (`next/dist/docs/01-app/01-getting-started/07-mutating-data.md` — Invoking
 * Server Functions). The same call answers every write, so an override that is
 * created, edited or deleted lands in one roundtrip and the list under the form
 * is always the list Postgres holds.
 *
 * Every number here carries an "as of" and never a rate: the counts come from
 * the metering flush (D166) and are therefore seconds behind, and the sampling
 * rate itself is a constant in the ingest binary (D165) that this tab describes
 * in words rather than restating as a number that could drift from it.
 */
function LiveIngestTab() {
  const [ingest, setIngest] = useState<LiveIngest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, run] = useTransition();

  // The load and every write share one runner and one error slot: the tab has
  // one piece of state and one way to replace it, so a write cannot leave the
  // screen showing a list that predates it — and a call that never came back
  // says so instead of leaving the last list looking current.
  const call = (work: () => Promise<IngestFormResult>) =>
    run(async () => {
      try {
        const result = await work();
        setIngest(result.ingest);
        setError(result.error);
      } catch (failure) {
        console.error("[settings] ingest tab", failure);
        setError(INGEST_UNREACHABLE);
      }
    });

  // Once, on open: this is a read of rows the flusher rewrites every few
  // seconds, and a tab that re-fetched on every render would poll Postgres by
  // accident. Refreshing is a tab switch away, and every write returns the
  // current list anyway.
  useEffect(() => {
    call(loadIngestHealth);
  }, []);

  if (!ingest) {
    return (
      <Section title="ingest health">
        <p className="py-1 text-[12.5px] text-faint">{error ?? "Reading health rows…"}</p>
      </Section>
    );
  }

  return (
    <>
      <Section title={`ingest health · ${ingest.keys.length} ${ingest.keys.length === 1 ? "key" : "keys"}`}>
        <div className="grid grid-cols-3 gap-3">
          <Stat label="events accepted" value={ingest.accepted} />
          <Stat label="receive-path errors" value={ingest.receiveErrors} warn />
          <Stat label="sampled out (quota)" value={ingest.droppedQuota} warn />
        </div>
        {/* The basis and the staleness in one sentence (D162): these are drops
            counted where a request is decoded, so a failure further in — a
            write that could not be enqueued — is not among them, and the whole
            row set is as old as the last metering flush. */}
        <p className="mt-2.5 font-mono text-[10.5px] leading-relaxed text-faint">
          {ingest.asOf
            ? `receive-path errors, as of ${ingest.asOf} — write-path failures are not counted here`
            : "no events on any key yet — these counts start with the first accepted record"}
        </p>

        <div className="mt-3 rounded-md border border-line bg-raised">
          {ingest.keys.length === 0 ? (
            <p className="px-3 py-2 text-[12.5px] text-faint">
              No keys yet — create one on the API keys tab and its health appears here.
            </p>
          ) : (
            ingest.keys.map((key) => (
              <div
                key={key.keyId}
                className="flex flex-wrap items-center gap-3 border-b border-line/60 px-3 py-2 last:border-0"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px] text-ink">
                    {key.name}
                    {key.revoked && (
                      <span className="ml-1.5 font-mono text-[9.5px] tracking-wide text-faint">
                        REVOKED
                      </span>
                    )}
                  </span>
                  <span className="block font-mono text-[10.5px] text-faint">{key.prefix}…</span>
                </span>
                <span className="font-mono text-[10.5px] text-faint">
                  {key.lastEvent ? `last event ${key.lastEvent}` : "no events yet"}
                </span>
                <span className="w-[190px] text-right font-mono text-[11px] text-mid">
                  {key.accepted.toLocaleString()} accepted · {key.errors.toLocaleString()} errors ·{" "}
                  {key.sampled.toLocaleString()} sampled
                </span>
              </div>
            ))
          )}
        </div>

        {/* Qualitative on purpose (D165): the rate is one constant, in Go. */}
        <p className="mt-2 font-mono text-[10.5px] leading-relaxed text-faint">
          malformed data is dropped and counted — ingest never 500s back at your services. Over
          quota it samples whole traces instead of cutting off: see Billing &amp; usage.
        </p>
      </Section>

      <Section title="model pricing · cost attribution">
        <p className="text-[12.5px] leading-relaxed text-mid">
          Cost is computed at ingest from tokens × these rates and stored on the span, so a trace
          keeps the price that was in force when it ran. An override matches a model-name PREFIX,
          longest match first, and your overrides are read before the built-in list — a family
          price you set here beats our per-version row for that family.
        </p>

        {error && (
          <p role="alert" className="mt-2.5 text-[12.5px] leading-relaxed" style={{ color: "var(--color-err)" }}>
            {error}
          </p>
        )}

        <div className="mt-3 rounded-md border border-line bg-raised">
          {ingest.overrides.length === 0 ? (
            <p className="px-3 py-2 text-[12.5px] text-faint">
              No overrides — every model is priced from the built-in list.
            </p>
          ) : (
            ingest.overrides.map((override) => (
              <div
                key={override.id}
                className="flex flex-wrap items-center gap-3 border-b border-line/60 px-3 py-2 last:border-0"
              >
                <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-mid">
                  {override.match}
                </span>
                <span className="font-mono text-[11.5px] text-mid">
                  ${override.inputPerMTok} in · ${override.outputPerMTok} out / M
                </span>
                <span className="w-24 text-right font-mono text-[10px] text-faint">
                  {override.updated}
                </span>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => {
                    const form = new FormData();
                    form.set("overrideId", override.id);
                    call(() => deleteOverride(form));
                  }}
                  className="font-mono text-[10.5px] text-faint hover:text-err disabled:opacity-60"
                  style={{ color: "var(--color-faint)" }}
                >
                  remove
                </button>
              </div>
            ))
          )}
        </div>

        {/* An uncontrolled form, submitted through the shared runner: the action
            returns the new list rather than redirecting, so a refusal leaves
            what was typed on screen beside the reason it was refused. */}
        <form
          action={(form: FormData) => call(() => saveOverride(form))}
          className="mt-3 flex flex-wrap gap-2"
        >
          <input
            name="match"
            required
            aria-label="Model name prefix"
            placeholder="model prefix, e.g. my-ft-classifier"
            className="min-w-[200px] flex-1 rounded-md border border-line bg-raised px-3 py-1.5 font-mono text-[12px] text-ink placeholder:text-faint focus:border-line-strong focus:outline-none"
          />
          <input
            name="inputPerMTok"
            required
            inputMode="decimal"
            aria-label="Input price per million tokens"
            placeholder="input $/M"
            className="w-[110px] rounded-md border border-line bg-raised px-3 py-1.5 font-mono text-[12px] text-ink placeholder:text-faint focus:border-line-strong focus:outline-none"
          />
          <input
            name="outputPerMTok"
            required
            inputMode="decimal"
            aria-label="Output price per million tokens"
            placeholder="output $/M"
            className="w-[110px] rounded-md border border-line bg-raised px-3 py-1.5 font-mono text-[12px] text-ink placeholder:text-faint focus:border-line-strong focus:outline-none"
          />
          <button
            type="submit"
            disabled={pending}
            className="flex items-center gap-1.5 rounded-md border border-line bg-raised px-3 py-1.5 text-[12.5px] text-mid hover:border-line-strong hover:text-ink disabled:opacity-60"
          >
            <Plus className="h-3.5 w-3.5" /> {pending ? "Saving…" : "Set price"}
          </button>
        </form>

        <p className="mt-2.5 font-mono text-[10.5px] leading-relaxed text-faint">
          {ingest.overrides.length} of {ingest.overrideMax} overrides used · everything else is
          priced from the built-in list of {ingest.pricedModels} models, last checked{" "}
          {ingest.pricesAsOf} · a new price applies to spans that arrive within 30 seconds, never
          to spans already stored
        </p>
      </Section>
    </>
  );
}

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
  // A customer coming back from Polar lands on the tab that answers them. The
  // return is reconciled on the server before this renders (D110's
  // poll-on-return), and its notice, the new plan and the meter it is measured
  // against all live in Billing & usage — opening on General would hide the
  // outcome of a payment behind a click.
  const [tab, setTab] = useState<Tab>(live?.billing.checkout ? "Billing & usage" : "General");
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
      {tab === "Billing & usage" && (live ? <LiveBillingTab live={live} /> : <BillingTab />)}
      {tab === "Data & ingest" && (live ? <LiveIngestTab /> : <IngestTab />)}
      {tab === "Audit log" && <AuditTab />}
      {tab === "Compliance" && <ComplianceTab />}
    </div>
  );
}
