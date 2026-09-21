import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { AccountLive } from "@/components/account/AccountLive";
import { avatarPath, describeUserAgent, type MembershipView, type SessionView } from "@/lib/account-types";
import { appHost } from "@/lib/app-href";
import { listMemberships, listOwnSessions, readAccount } from "@/server/account";
import { listAvatarEtags } from "@/server/avatars";
import { dataMode } from "@/server/data";
import { queryRows } from "@/server/postgres";
import { accountFeedback } from "./errors";

/**
 * The reads of the account surface (D707); the writes are `actions.ts`.
 *
 * Mock mode returns FIRST, before `connection()` and before `searchParams` is
 * awaited — the settings page's D125 ordering, for the same reason: the demo
 * product has no accounts and no Postgres, so this page must reach for
 * neither, and a request-time API above the mode check would stop the page
 * prerendering in a mock build. What it renders instead of forms is the D150
 * state: the truth about this deployment in the present tense, and two
 * pointers that lead somewhere real in this build (D327).
 *
 * Live mode is per-request by construction — whose name, whose sessions — so
 * it holds for a real request (D27a) and reads through the session the request
 * arrived on. Nothing on this page takes a user from the URL: the person is
 * the session's, the session rows are that person's, and the memberships are
 * that person's (D148, applied to a user rather than a tenant).
 */

const POINTER =
  "rounded-md border border-line bg-raised px-3 py-2.5 text-center text-[13px] font-medium text-ink hover:border-line-strong";

/**
 * UTC, and formatted here rather than in the component: a date formatted on
 * both sides of hydration is formatted in two timezones (the settings page's
 * rule). Minute precision on the two session instants because a session's
 * expiry is a fact a person may be deciding against right now; day precision
 * on the two dates that are history.
 */
const asDay = (at: Date): string => at.toISOString().slice(0, 10);
const asMinute = (at: Date): string => `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[]; saved?: string | string[] }>;
}) {
  // The mock deployment's account page: no form, no field, no button (D150),
  // and no SAMPLE badge — a badge marks fabricated data on a real surface, and
  // there is no account surface here to mark. Same notice as `/login`'s mock
  // branch, told from inside the shell, and INLINE like that page's rather
  // than a component: the mock-mode shim walks the returned tree without
  // rendering, so the honest state has to be the elements this function
  // returns. Both pointers are real in this build: the overview this demo IS,
  // and the docs page that explains what an account is on an obstack that has
  // them (served on the in-app mount, so a reader stays in the shell).
  if (dataMode !== "live") {
    // D340: this branch is prerendered, so the host, if any, is a build-time
    // constant — the same OBSTACK_APP_ORIGIN the auth pages read.
    const host = appHost();
    return (
      <div className="mx-auto max-w-3xl px-5 py-6">
        <h1 className="font-display text-[19px] font-semibold text-ink">Account</h1>
        <p className="mt-2 max-w-prose text-[13px] leading-relaxed text-mid">
          This deployment is the obstack prototype: it shows fictional data and keeps no accounts,
          so there is no name, email address or password here to change, and no session to sign
          out.
        </p>
        <p className="mt-2 max-w-prose text-[13px] leading-relaxed text-mid">
          Accounts are real {host ? `on ${host}` : "on an obstack you run yourself"}, where this
          page holds all four.
        </p>
        <div className="mt-6 flex max-w-sm flex-col gap-2.5">
          <Link href="/app" className={POINTER}>
            Back to the overview
          </Link>
          <Link href="/app/docs/accounts-and-access" className={POINTER}>
            How accounts work
          </Link>
        </div>
      </div>
    );
  }
  await connection();

  // The layout redirects too, but a layout does not control whether the
  // segment below it renders (its own note): this page resolves its own
  // session, so it answers for itself rather than reading a person off a null
  // (D274 — the no-session branch is a redirect, never a throw).
  const requestHeaders = await headers();
  const account = await readAccount(requestHeaders);
  if (!account) redirect("/login");

  const [sessions, memberships, avatars] = await Promise.all([
    listOwnSessions(account.userId, queryRows),
    listMemberships(account.userId, queryRows),
    listAvatarEtags([account.userId], queryRows),
  ]);
  const avatarEtag = avatars.get(account.userId);

  const sessionViews: SessionView[] = sessions.map((session) => ({
    id: session.id,
    current: session.id === account.sessionId,
    signedIn: asMinute(session.createdAt),
    expires: asMinute(session.expiresAt),
    ip: session.ipAddress,
    client: describeUserAgent(session.userAgent),
  }));

  const membershipViews: MembershipView[] = memberships.map((membership) => ({
    orgId: membership.orgId,
    orgName: membership.orgName,
    role: membership.role,
    joined: asDay(membership.joinedAt),
  }));

  return (
    <AccountLive
      account={{
        name: account.name,
        email: account.email,
        memberSince: asDay(account.createdAt),
        avatar: avatarEtag ? avatarPath(account.userId, avatarEtag) : null,
      }}
      sessions={sessionViews}
      memberships={membershipViews}
      // Both codes off the URL are mapped to fixed copy and never rendered (D121/D712).
      feedback={accountFeedback(await searchParams)}
    />
  );
}
