import type { Metadata } from "next";
import Link from "next/link";
import { Wordmark } from "@/components/shell/Wordmark";
import { appHost } from "@/lib/app-href";
import { dataMode } from "@/server/data";
import { signUp } from "./actions";
import { signupErrorMessage } from "./errors";

export const metadata: Metadata = { title: "Sign up — obstack" };

const PAGE = "flex min-h-screen items-center justify-center bg-bg px-5 py-12";
const FIELD =
  "w-full rounded-md border border-line bg-raised px-3 py-2 text-[13px] text-ink placeholder:text-faint focus:border-line-strong focus:outline-none";
const LABEL = "block font-mono text-[10.5px] uppercase tracking-widest text-faint";
const POINTER =
  "rounded-md border border-line bg-raised px-3 py-2.5 text-[13px] font-medium text-ink hover:border-line-strong";

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  // Mock mode is the prototype deployment: fictional data, no account
  // database, no auth secret. So it renders NO form (D150) — a form here could
  // only ever fail, and asking a stranger for a password on a deployment that
  // cannot keep one is the D13/D21 lie in its worst place. The check reads the
  // ONE mode predicate the app shell reads (`server/data.ts`), and it
  // short-circuits AHEAD of everything auth: nothing below this line runs, so
  // this page renders with BETTER_AUTH_SECRET and Postgres both absent, which
  // is exactly how the prototype runs.
  //
  // What it says instead of a form: the truth about this deployment in the
  // present tense (D140) — it shows fictional data, it keeps no accounts — and
  // the two things a visitor CAN do right now, both real. No "coming soon", no
  // disabled form, no SAMPLE badge: a badge marks fabricated data on a real
  // surface, and there is no signup surface here to mark.
  if (dataMode === "mock") {
    // D340: this build is prerendered, so the host, if any, is a build-time
    // constant — the same OBSTACK_APP_ORIGIN the marketing image bakes into
    // the CTAs `appHref` wraps.
    const host = appHost();
    return (
      <div className={PAGE}>
        <div className="w-full max-w-sm">
          <Link href="/" aria-label="obstack">
            <Wordmark size="lg" />
          </Link>

          <h1 className="mt-8 text-[19px] font-semibold text-ink">
            Signup runs on your own obstack
          </h1>
          <p className="mt-1.5 text-[13px] leading-relaxed text-mid">
            This deployment is the obstack prototype: every number in it is fictional data and it
            keeps no accounts, so there is no workspace to create here.
          </p>
          <p className="mt-3 text-[13px] leading-relaxed text-mid">
            Signing up is real {host ? `on ${host}` : "on an obstack you run yourself"} — it
            creates one organization with one workspace, and your account owns it.
          </p>

          {/* Two pointers, both real and both in this build (D327): the demo
              this deployment IS, and the documentation it serves. The second
              used to be a cloud sign-up anchor on the landing page — which
              offered a hosted obstack that does not exist, and became a dead
              link the moment D257 removed the block it pointed at.

              WHY THE FIRST ONE MAY SAY "demo" HERE and may not on `/`, `/docs`,
              `/status` or `/changelog`. Those pages ship the same bytes to both
              images, so they call `/app` the app. This tree is inside the
              `dataMode === "mock"` branch above: it renders ONLY in the mock
              image, which is the one where `/app` is the demo — the live image
              never reaches this line, it renders the form below. The gate is
              the whole warrant for the word, so it is pinned rather than
              trusted: `mock-mode.test.ts` asserts the label on the tree this
              branch returns, and `app/landing-fence.test.ts` (g) asserts that
              it appears nowhere in this file outside the branch. */}
          <div className="mt-7 flex flex-col gap-2.5">
            <Link href="/app" className={POINTER}>
              Open the demo
            </Link>
            <Link href="/docs/quickstart" className={POINTER}>
              Read the quickstart
            </Link>
          </div>
        </div>
      </div>
    );
  }
  // The code is mapped to fixed copy, never rendered (D121): `?error=` is a
  // vocabulary, not a message channel.
  const message = signupErrorMessage((await searchParams).error);
  return (
    <div className={PAGE}>
      <div className="w-full max-w-sm">
        <Link href="/" aria-label="obstack">
          <Wordmark size="lg" />
        </Link>

        <h1 className="mt-8 text-[19px] font-semibold text-ink">Create your workspace</h1>
        {/* The identity shape, stated plainly — org → one workspace (D95) — now
            with the ingest wire path, which this sprint made true: keys are issued
            in settings and resolve out of Postgres to the workspace that issued
            them (D98), so the scoping line is a fact rather than the promise
            D13/D21 kept it from being while keys mapped by env. */}
        <p className="mt-1.5 text-[13px] leading-relaxed text-mid">
          Signing up creates one organization with one workspace, and your account owns it.
          Telemetry sent with a key you issue in settings lands in that workspace and no other.
        </p>

        <form action={signUp} className="mt-7 flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label className={LABEL} htmlFor="name">
              name
            </label>
            <input id="name" name="name" autoComplete="name" required className={FIELD} />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className={LABEL} htmlFor="email">
              email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              className={FIELD}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className={LABEL} htmlFor="password">
              password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="new-password"
              required
              className={FIELD}
            />
          </div>

          {message && (
            <p role="alert" className="text-[12.5px] leading-relaxed" style={{ color: "var(--color-err)" }}>
              {message}
            </p>
          )}

          <button
            type="submit"
            className="mt-1 rounded-md bg-ink px-3 py-2 text-[13px] font-semibold text-bg hover:opacity-90"
          >
            Create workspace
          </button>
        </form>

        <p className="mt-6 text-[12.5px] text-mid">
          Already have an account?{" "}
          <Link href="/login" className="text-ink underline underline-offset-2">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
