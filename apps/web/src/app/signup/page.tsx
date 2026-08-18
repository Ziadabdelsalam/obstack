import type { Metadata } from "next";
import Link from "next/link";
import { Wordmark } from "@/components/shell/Wordmark";
import { signUp } from "./actions";
import { signupErrorMessage } from "./errors";

export const metadata: Metadata = { title: "Sign up — obstack" };

const FIELD =
  "w-full rounded-md border border-line bg-raised px-3 py-2 text-[13px] text-ink placeholder:text-faint focus:border-line-strong focus:outline-none";
const LABEL = "block font-mono text-[10.5px] uppercase tracking-widest text-faint";

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  // The code is mapped to fixed copy, never rendered (D121): `?error=` is a
  // vocabulary, not a message channel.
  const message = signupErrorMessage((await searchParams).error);
  return (
    <div className="flex min-h-screen items-center justify-center bg-bg px-5 py-12">
      <div className="w-full max-w-sm">
        <Link href="/" aria-label="obstack">
          <Wordmark size="lg" />
        </Link>

        <h1 className="mt-8 text-[19px] font-semibold text-ink">Create your workspace</h1>
        {/* The identity shape, stated plainly — org → one workspace (D95) — and
            nothing about the ingest wire path: an API key still maps to a workspace
            by env this sprint (D115), so "everything you send is scoped to it" would
            promise a capability that does not exist yet (D13/D21). */}
        <p className="mt-1.5 text-[13px] leading-relaxed text-mid">
          Signing up creates one organization with one workspace, and your account owns it.
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
