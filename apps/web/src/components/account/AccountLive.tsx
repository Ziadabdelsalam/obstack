import Link from "next/link";
import {
  NAME_MAX,
  PASSWORD_MAX,
  PASSWORD_MIN,
  type AccountFeedback,
  type AccountSection,
  type AccountView,
  type MembershipView,
  type SessionView,
} from "@/lib/account-types";
import {
  removeAvatar,
  revokeOtherSessions,
  revokeSession,
  updateEmail,
  updateName,
  updatePassword,
} from "@/app/app/account/actions";
import { Avatar, initialsOf } from "@/components/ui/Avatar";
import { AvatarPicker } from "./AvatarPicker";

/**
 * The account page's live body (D707): the signed-in PERSON — name, sign-in
 * address, password, sessions, memberships — as distinct from the workspace,
 * which `/app/settings` owns. A SERVER component (no client directive, the
 * D392 rule): every control here is a plain `<form action={…}>` posting to a
 * Server Function and every result arrives as a redirect the page re-renders
 * from, so there is no client state to hold and no reason to ship client JS
 * for interactivity that does not exist. Forms in Server Components submit
 * even before hydration (Next's own note in `07-mutating-data.md`).
 *
 * Fed exclusively by `app/app/account/page.tsx` — resolved, server-fetched
 * props, every timestamp already a UTC string — with no `@/mock/` import
 * anywhere in this file. The feedback a redirect carried lands INSIDE the
 * section it is about (D712): the page resolved the code to a sentence and a
 * section, and this file only asks "is it mine".
 */

const FIELD =
  "w-full rounded-md border border-line bg-raised px-3 py-1.5 text-[13px] text-ink placeholder:text-faint focus:border-line-strong focus:outline-none";
const LABEL = "block font-mono text-[10.5px] uppercase tracking-widest text-faint";
const PRIMARY =
  "rounded-md px-3 py-1.5 text-[12.5px] font-medium text-bg hover:opacity-90 disabled:opacity-60";
const SECONDARY =
  "rounded-md border border-line bg-raised px-3 py-1.5 text-[12.5px] text-mid hover:border-line-strong hover:text-ink";
const QUIET = "font-mono text-[10.5px] text-faint hover:text-err";

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

/**
 * The sentence a redirect carried, rendered in the one section it belongs to
 * and nowhere else. An error is an `alert`; a notice is a `status` — the
 * assistive-technology distinction between "act on this" and "this happened".
 */
function Note({ feedback, section }: { feedback: AccountFeedback | null; section: AccountSection }) {
  if (!feedback || feedback.section !== section) return null;
  const error = feedback.kind === "error";
  return (
    <p
      role={error ? "alert" : "status"}
      className="mb-3 text-[12.5px] leading-relaxed"
      style={{ color: error ? "var(--color-err)" : "var(--color-ok)" }}
    >
      {feedback.message}
    </p>
  );
}

function ProfileSection({
  account,
  feedback,
}: {
  account: AccountView;
  feedback: AccountFeedback | null;
}) {
  return (
    <Section title="profile">
      <Note feedback={feedback} section="avatar" />
      {/* The picture (D718): stored bytes served by the avatar route to people
          who share an organization, or the initials when there is none. The
          picker is the one client island on this page — it shrinks the file
          before the same form posts it. */}
      <div className="flex flex-wrap items-center gap-4">
        <Avatar src={account.avatar} alt={account.name} initials={initialsOf(account.name, account.email)} size={64} />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <AvatarPicker />
          {account.avatar && (
            <form action={removeAvatar}>
              <button type="submit" className={QUIET} style={{ color: "var(--color-faint)" }}>
                remove picture
              </button>
            </form>
          )}
        </div>
      </div>
      <p className="mt-2 text-[12.5px] leading-relaxed text-mid">
        Shown beside your name in the top bar, and on the members roster to the people who share an
        organization with you.
      </p>

      <div className="mt-5 border-t border-line/60 pt-4">
      <Note feedback={feedback} section="name" />
      <form action={updateName} className="flex flex-wrap items-end gap-2">
        <div className="flex min-w-[220px] flex-1 flex-col gap-1.5">
          <label className={LABEL} htmlFor="account-name">
            name
          </label>
          <input
            id="account-name"
            name="name"
            defaultValue={account.name}
            maxLength={NAME_MAX}
            autoComplete="name"
            required
            className={FIELD}
          />
        </div>
        <button type="submit" className={PRIMARY} style={{ background: "var(--color-ink)" }}>
          Save name
        </button>
      </form>
      <p className="mt-2 text-[12.5px] leading-relaxed text-mid">
        Shown in the top bar and on the members roster of every organization you belong to.
      </p>
      </div>

      <div className="mt-5 border-t border-line/60 pt-4">
        <Note feedback={feedback} section="email" />
        <form action={updateEmail} className="flex flex-wrap items-end gap-2">
          <div className="flex min-w-[220px] flex-1 flex-col gap-1.5">
            <label className={LABEL} htmlFor="account-email">
              email
            </label>
            <input
              id="account-email"
              name="email"
              type="email"
              defaultValue={account.email}
              autoComplete="email"
              required
              className={FIELD}
            />
          </div>
          <button type="submit" className={SECONDARY}>
            Change email
          </button>
        </form>
        {/* Present tense, and every clause is a fact about this config (D140):
            no email is sent anywhere in obstack (U4), the change applies on
            the redirect, and an invitation is matched against the signed-in
            address case-insensitively (`invites.ts`). */}
        <p className="mt-2 text-[12.5px] leading-relaxed text-mid">
          You sign in with this address, and invitations are matched against it — an invite sent to
          your old address stops working for this account once you change it. No confirmation
          email is sent: the change applies at once.
        </p>
      </div>

      <div className="mt-4 flex items-center justify-between gap-4 border-t border-line/60 pt-3">
        <span className="font-mono text-[11px] uppercase tracking-widest text-faint">member since</span>
        <span className="font-mono text-[12.5px] text-mid">{account.memberSince}</span>
      </div>
    </Section>
  );
}

function PasswordSection({ feedback }: { feedback: AccountFeedback | null }) {
  return (
    <Section title="password">
      <Note feedback={feedback} section="password" />
      <form action={updatePassword} className="flex flex-col gap-3">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="flex flex-col gap-1.5">
            <label className={LABEL} htmlFor="current-password">
              current password
            </label>
            <input
              id="current-password"
              name="currentPassword"
              type="password"
              autoComplete="current-password"
              required
              className={FIELD}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className={LABEL} htmlFor="new-password">
              new password
            </label>
            <input
              id="new-password"
              name="newPassword"
              type="password"
              autoComplete="new-password"
              minLength={PASSWORD_MIN}
              maxLength={PASSWORD_MAX}
              required
              className={FIELD}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className={LABEL} htmlFor="confirm-password">
              new password, again
            </label>
            <input
              id="confirm-password"
              name="confirmPassword"
              type="password"
              autoComplete="new-password"
              minLength={PASSWORD_MIN}
              maxLength={PASSWORD_MAX}
              required
              className={FIELD}
            />
          </div>
        </div>
        <label className="flex items-center gap-2 text-[12.5px] text-mid">
          <input type="checkbox" name="revokeOthers" value="1" className="accent-[var(--color-api)]" />
          Also sign out every other session
        </label>
        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" className={PRIMARY} style={{ background: "var(--color-ink)" }}>
            Change password
          </button>
          <span className="font-mono text-[10.5px] text-faint">
            {PASSWORD_MIN} to {PASSWORD_MAX} characters
          </span>
        </div>
      </form>
      {/* The absence, on the surface that would otherwise imply the feature:
          obstack sends no email, so a forgotten password has no reset link,
          and the page says so rather than leaving a reader to look for one. */}
      <p className="mt-3 text-[12.5px] leading-relaxed text-mid">
        A password you still know is changed here. obstack sends no email, so there is no reset
        link for one you have forgotten.
      </p>
    </Section>
  );
}

function SessionsSection({
  sessions,
  feedback,
}: {
  sessions: SessionView[];
  feedback: AccountFeedback | null;
}) {
  const others = sessions.filter((session) => !session.current);
  return (
    <Section title={`sessions · ${sessions.length}`}>
      <Note feedback={feedback} section="sessions" />
      {sessions.map((session) => (
        <div
          key={session.id}
          className="flex flex-wrap items-center gap-3 border-b border-line/60 py-2.5 last:border-0"
        >
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="truncate text-[13px] text-ink">{session.client}</span>
              {session.current && (
                <span
                  className="rounded-[3px] px-1.5 py-px font-mono text-[9.5px] tracking-wide"
                  style={{
                    color: "var(--color-ok)",
                    background: "color-mix(in srgb, var(--color-ok) 12%, transparent)",
                  }}
                >
                  THIS SESSION
                </span>
              )}
            </span>
            <span className="block font-mono text-[10.5px] text-faint">
              {session.ip ?? "no address recorded"} · signed in {session.signedIn} · expires{" "}
              {session.expires}
            </span>
          </span>
          {session.current ? (
            <span className="font-mono text-[10.5px] text-faint">sign out from the top bar</span>
          ) : (
            <form action={revokeSession}>
              <input type="hidden" name="sessionId" value={session.id} />
              <button type="submit" className={QUIET} style={{ color: "var(--color-faint)" }}>
                sign out
              </button>
            </form>
          )}
        </div>
      ))}
      {/* A button only where there is something for it to do: with one session
          there is nothing else to end, and a disabled control would be an
          affordance with nothing behind it. */}
      {others.length > 0 ? (
        <form action={revokeOtherSessions} className="mt-3">
          <button type="submit" className={SECONDARY}>
            Sign out everywhere else
          </button>
        </form>
      ) : (
        <p className="mt-3 text-[12.5px] text-faint">This is the only session signed in to your account.</p>
      )}
      {/* Both clauses are properties of this config: the store is the one
          session authority (no cookie cache, no secondary storage — `server/
          account.ts`), so a deleted row ends on the next request; and the
          address is whatever the proxy forwarded (D359), which is nothing on a
          direct connection. */}
      <p className="mt-3 text-[12.5px] leading-relaxed text-mid">
        A session you sign out ends on its next request. The address is the one the request
        arrived from as obstack saw it, which may be a proxy&rsquo;s, or none.
      </p>
    </Section>
  );
}

function MembershipsSection({ memberships }: { memberships: MembershipView[] }) {
  return (
    <Section title={`organizations · ${memberships.length}`}>
      {memberships.map((membership) => (
        <div
          key={membership.orgId}
          className="flex flex-wrap items-center gap-3 border-b border-line/60 py-2.5 last:border-0"
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] text-ink">{membership.orgName}</span>
            <span className="block font-mono text-[10.5px] text-faint">joined {membership.joined}</span>
          </span>
          <span className="font-mono text-[11px] text-mid">{membership.role}</span>
        </div>
      ))}
      {/* D120/D717, said where a second row would otherwise raise the question:
          the session reads one workspace at a time — the owned org's by
          default — and every row here is somewhere the sidebar can switch to. */}
      <p className="mt-3 text-[12.5px] leading-relaxed text-mid">
        Your session reads one workspace at a time: by default the one belonging to the
        organization you own. Every organization listed here is one you can switch to from the
        sidebar; accepting an invitation adds a row and changes nothing until you do.
      </p>
    </Section>
  );
}

export function AccountLive({
  account,
  sessions,
  memberships,
  feedback,
}: {
  account: AccountView;
  sessions: SessionView[];
  memberships: MembershipView[];
  feedback: AccountFeedback | null;
}) {
  return (
    <div className="mx-auto max-w-3xl px-5 py-6" data-tour="account">
      <h1 className="font-display text-[19px] font-semibold text-ink">Account</h1>
      <p className="mt-1 text-[12.5px] leading-relaxed text-mid">
        You, not the workspace. The organization&rsquo;s members, API keys and plan are under{" "}
        <Link href="/app/settings" className="text-ink underline underline-offset-2">
          Settings
        </Link>
        .
      </p>
      <Note feedback={feedback} section="account" />
      <div className="mt-5">
        <ProfileSection account={account} feedback={feedback} />
        <PasswordSection feedback={feedback} />
        <SessionsSection sessions={sessions} feedback={feedback} />
        <MembershipsSection memberships={memberships} />
      </div>
    </div>
  );
}
