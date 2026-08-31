import type { Metadata } from "next";
import Link from "next/link";
import { Wordmark } from "@/components/shell/Wordmark";
import { dataMode } from "@/server/data";
import { logIn } from "./actions";
import { loginErrorMessage } from "./errors";

export const metadata: Metadata = { title: "Sign in — obstack" };

const PAGE = "flex min-h-screen items-center justify-center bg-bg px-5 py-12";
const FIELD =
  "w-full rounded-md border border-line bg-raised px-3 py-2 text-[13px] text-ink placeholder:text-faint focus:border-line-strong focus:outline-none";
const LABEL = "block font-mono text-[10.5px] uppercase tracking-widest text-faint";
const POINTER =
  "rounded-md border border-line bg-raised px-3 py-2.5 text-[13px] font-medium text-ink hover:border-line-strong";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  // Same treatment as /signup, for the same reason (D150): mock mode keeps no
  // accounts, so there is no session to open and no form to offer. The mode
  // check is the app shell's one predicate and it short-circuits ahead of every
  // auth import's first use — with no BETTER_AUTH_SECRET present, this page
  // still renders.
  //
  // Same notice too, told from the sign-in side. It does not link on to
  // /signup: in this mode that page says the same thing, and a pointer has to
  // lead somewhere real.
  if (dataMode === "mock") {
    return (
      <div className={PAGE}>
        <div className="w-full max-w-sm">
          <Link href="/" aria-label="obstack">
            <Wordmark size="lg" />
          </Link>

          <h1 className="mt-8 text-[19px] font-semibold text-ink">
            Sign-in runs on your own obstack
          </h1>
          <p className="mt-1.5 text-[13px] leading-relaxed text-mid">
            This deployment is the obstack prototype: it shows fictional data and keeps no
            accounts, so there is nothing here to sign in to.
          </p>
          <p className="mt-3 text-[13px] leading-relaxed text-mid">
            Accounts are real on an obstack you host yourself. We don&apos;t host obstack for
            anyone yet.
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
              trusted: `signup/mock-mode.test.ts` asserts the label on the tree
              this branch returns, and `app/landing-fence.test.ts` (g) asserts
              that it appears nowhere in this file outside the branch. */}
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
  // The code is mapped to fixed copy, never rendered (D121).
  const message = loginErrorMessage((await searchParams).error);
  return (
    <div className={PAGE}>
      <div className="w-full max-w-sm">
        <Link href="/" aria-label="obstack">
          <Wordmark size="lg" />
        </Link>

        <h1 className="mt-8 text-[19px] font-semibold text-ink">Sign in</h1>

        <form action={logIn} className="mt-7 flex flex-col gap-4">
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
              autoComplete="current-password"
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
            Sign in
          </button>
        </form>

        <p className="mt-6 text-[12.5px] text-mid">
          No account yet?{" "}
          <Link href="/signup" className="text-ink underline underline-offset-2">
            Create a workspace
          </Link>
        </p>
      </div>
    </div>
  );
}
