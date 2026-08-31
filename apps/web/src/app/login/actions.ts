"use server";

import { redirect } from "next/navigation";
import { getAuth } from "@/server/auth";
import { dataMode } from "@/server/data";
import { checkRateLimit, getClientIp } from "@/server/rate-limit";
import { loginErrorCode, type LoginErrorCode } from "./errors";

/** Same split as signup's: `errors.ts` names the failure, this surface logs the ones it could not name. */
function codeFor(error: unknown): LoginErrorCode {
  const code = loginErrorCode(error);
  if (code === "login-failed") console.error("[login]", error);
  return code;
}

/** `code` is a literal union — nothing a caller supplies can reach the query string. */
const back = (code: LoginErrorCode) => redirect(`/login?error=${code}`);

export async function logIn(formData: FormData): Promise<void> {
  // Signup's tripwire, exactly (D150): mock mode offers no form, so this
  // returns without building the auth instance — the only line here that would
  // read BETTER_AUTH_SECRET — and without an error code, because there is no
  // form for one to land on.
  if (dataMode === "mock") {
    console.error("[login] posted in mock mode — this deployment keeps no accounts");
    return;
  }

  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");

  if (!email || !password) back("missing-fields");

  // D339: obstack's own abuse control ahead of the in-process sign-in call —
  // better-auth's own limiter never runs for it (`server/rate-limit.ts`'s
  // header comment). Refused here, before better-auth is ever called, so its
  // own vocabulary member renders (F1) rather than the generic `login-failed`
  // that a real sign-in failure would produce.
  const ip = await getClientIp();
  if (!checkRateLimit("login", ip)) back("rate_limited");

  try {
    await getAuth().api.signInEmail({ body: { email, password } });
  } catch (error) {
    back(codeFor(error));
  }

  redirect("/app");
}
