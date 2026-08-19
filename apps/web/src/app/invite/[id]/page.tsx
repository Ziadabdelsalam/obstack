import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { connection } from "next/server";
import { Wordmark } from "@/components/shell/Wordmark";
import { getAuth } from "@/server/auth";
import { dataMode } from "@/server/data";
import {
  findJoinedOrgName,
  getInviteForRecipient,
  parseInvitationId,
  type InviteForRecipient,
} from "@/server/invites";
import { queryRows } from "@/server/postgres";
import { acceptInvitation } from "./actions";
import { INVITE_ERRORS, inviteErrorCode, inviteErrorMessage } from "./errors";

export const metadata: Metadata = { title: "Join a workspace — obstack" };

const CARD = "flex min-h-screen items-center justify-center bg-bg px-5 py-12";
const BUTTON =
  "mt-1 rounded-md bg-ink px-3 py-2 text-[13px] font-semibold text-bg hover:opacity-90";
const BODY = "mt-1.5 text-[13px] leading-relaxed text-mid";
const LINK = "text-ink underline underline-offset-2";

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className={CARD}>
      <div className="w-full max-w-sm">
        <Link href="/" aria-label="obstack">
          <Wordmark size="lg" />
        </Link>
        {children}
      </div>
    </div>
  );
}

/** One shape for every dead end: a heading, a true sentence, and the way out. */
function Dead({ title, message }: { title: string; message: string }) {
  return (
    <Frame>
      <h1 className="mt-8 text-[19px] font-semibold text-ink">{title}</h1>
      <p className={BODY}>{message}</p>
      <p className="mt-6 text-[12.5px] text-mid">
        <Link href="/app" className={LINK}>
          Go to your workspace
        </Link>
      </p>
    </Frame>
  );
}

/**
 * D149: no session, no accept. The two links are the whole affordance — there is
 * deliberately NO `?next=` or redirect-back parameter, because a parameter that
 * names where to send a browser after sign-in is an open-redirect channel of
 * exactly the D68 class, and "reopen your invite link" costs the one person who
 * hits this a click.
 *
 * The email sentence is not a nicety: better-auth accepts an invitation only
 * when the signed-in address equals the invited one, case-insensitively
 * (measured, `crud-invites.mjs:269`), so signing in with the wrong account is
 * the failure this page can prevent instead of explain.
 */
function SignInPrompt() {
  return (
    <Frame>
      <h1 className="mt-8 text-[19px] font-semibold text-ink">You&rsquo;ve been invited</h1>
      <p className={BODY}>
        Sign in, then reopen your invite link. The link works only for an account with the email
        address it was sent to.
      </p>
      <p className="mt-6 flex gap-4 text-[12.5px] text-mid">
        <Link href="/login" className={LINK}>
          Sign in
        </Link>
        <Link href="/signup" className={LINK}>
          Create an account
        </Link>
      </p>
    </Frame>
  );
}

/**
 * D140, present tense and nothing else. Membership is what acceptance produced;
 * the invitee's own workspace is what they still see, because resolution is
 * owner-pinned (`session.ts`) and acceptance adds a member row rather than
 * moving anyone. Viewing the org they joined is the S3.5 switcher's job, so this
 * copy does not mention it — a "soon" here would be a promise the product cannot
 * keep (D13/D21).
 */
function Joined({ organizationName }: { organizationName: string }) {
  return (
    <Frame>
      <h1 className="mt-8 text-[19px] font-semibold text-ink">
        You&rsquo;ve joined {organizationName}
      </h1>
      <p className={BODY}>
        You&rsquo;ve joined {organizationName} as a member. You&rsquo;re viewing your own workspace.
      </p>
      <p className="mt-6 text-[12.5px] text-mid">
        <Link href="/app" className={LINK}>
          Go to your workspace
        </Link>
      </p>
    </Frame>
  );
}

/** The one state with a button: a pending invitation, addressed to the signed-in account. */
function AcceptCard({
  invite,
  message,
}: {
  invite: InviteForRecipient;
  message: string | null;
}) {
  return (
    <Frame>
      <h1 className="mt-8 text-[19px] font-semibold text-ink">
        Join {invite.organizationName}
      </h1>
      {/* The same present-tense truth the success surface tells, said before the
          click: membership is additive, and one account still sees one
          workspace. */}
      <p className={BODY}>
        Accepting adds {invite.email} to {invite.organizationName} as a member. obstack shows one
        workspace per account, so you&rsquo;ll keep seeing your own.
      </p>

      <form action={acceptInvitation} className="mt-7 flex flex-col gap-4">
        <input type="hidden" name="invitationId" value={invite.id} />
        {message && (
          <p
            role="alert"
            className="text-[12.5px] leading-relaxed"
            style={{ color: "var(--color-err)" }}
          >
            {message}
          </p>
        )}
        <button type="submit" className={BUTTON}>
          Accept invitation
        </button>
      </form>
    </Frame>
  );
}

export default async function InvitePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  // Every branch below is a fact about who is asking and what one row says, so
  // there is nothing here to prerender — `connection()` is Next 16's way of
  // saying so (D27a), and it runs before the mode check so the mock build cannot
  // bake this page either.
  await connection();

  // Mock mode has no accounts and no Postgres, and must keep touching neither
  // (D114/D125). The honest answer is that this link belongs to the signed-in
  // product, not a 500 from a pool that was never configured.
  if (dataMode !== "live") {
    return (
      <Dead
        title="Invites need the signed-in product"
        message="This is the obstack demo, which runs on sample data with no accounts. Invite links work on an obstack you run yourself."
      />
    );
  }

  // The code is mapped to fixed copy, never rendered (D121/D149): `?error=` is a
  // vocabulary, not a message channel.
  const message = inviteErrorMessage((await searchParams).error);
  const requestHeaders = await headers();
  const session = await getAuth().api.getSession({ headers: requestHeaders });
  if (!session) return <SignInPrompt />;

  // An id that is not an id never reaches Postgres or the library (D68). It gets
  // the same sentence a spent link gets, because from the reader's side it IS
  // one: a link that does not work.
  const id = parseInvitationId((await params).id);
  if (!id) return <Dead title="Invite link" message={INVITE_ERRORS["not-found"]} />;

  let invite: InviteForRecipient;
  try {
    invite = await getInviteForRecipient(id, requestHeaders);
  } catch (error) {
    // Accepted invitations are "not found" to better-auth (it serves pending
    // rows only), so the store is asked before the failure is believed —
    // otherwise reopening the link a second after joining would say it is dead.
    const joined = await findJoinedOrgName(id, session.user.id, session.user.email, queryRows);
    if (joined) return <Joined organizationName={joined} />;
    const code = inviteErrorCode(error);
    if (code === "invite-failed") console.error("[invite]", error);
    return <Dead title="Invite link" message={INVITE_ERRORS[code]} />;
  }

  return <AcceptCard invite={invite} message={message} />;
}
