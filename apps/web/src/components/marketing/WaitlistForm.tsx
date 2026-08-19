"use client";

import { useActionState, useId } from "react";
import { joinWaitlist, type WaitlistState } from "./actions";

/** Error codes → fixed copy; the state never carries words of its own. */
const MESSAGE: Record<Exclude<WaitlistState, "idle" | "joined">, string> = {
  "invalid-email": "That doesn't look like an email address.",
  failed: "Saving your email didn't work — please try again.",
};

/**
 * The landing page's waitlist capture. Rendered more than once per page, so
 * the input id comes from `useId`. On success the form is gone — the replaced
 * confirmation is the receipt, and there is nothing left to double-submit.
 */
export function WaitlistForm() {
  const [state, formAction, pending] = useActionState(joinWaitlist, "idle");
  const id = useId();

  if (state === "joined") {
    return (
      <p role="status" className="text-[13.5px] leading-relaxed text-mid">
        <span className="font-medium" style={{ color: "var(--color-ok)" }}>
          You&apos;re on the list.
        </span>{" "}
        We&apos;ll email you when your invite is ready.
      </p>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={id} className="sr-only">
          email
        </label>
        <input
          id={id}
          name="email"
          type="email"
          autoComplete="email"
          required
          placeholder="you@company.com"
          className="w-full max-w-[260px] rounded-md border border-line bg-raised px-3 py-2 text-[13px] text-ink placeholder:text-faint focus:border-line-strong focus:outline-none"
        />
        <button
          type="submit"
          disabled={pending}
          className="rounded-md px-4 py-2 text-[13px] font-medium text-bg transition-transform hover:scale-[1.03] disabled:opacity-60"
          style={{ background: "var(--color-ink)" }}
        >
          {pending ? "Joining…" : "Join the waitlist"}
        </button>
      </div>
      {state !== "idle" && (
        <p role="alert" className="text-[12.5px] leading-relaxed" style={{ color: "var(--color-err)" }}>
          {MESSAGE[state]}
        </p>
      )}
    </form>
  );
}
