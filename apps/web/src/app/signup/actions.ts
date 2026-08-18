"use server";

import { redirect } from "next/navigation";
import { signUpWithWorkspace } from "@/server/auth";
import { signupErrorCode, type SignupErrorCode } from "./errors";

/**
 * The mapping itself lives in `errors.ts`, beside the words it selects and
 * where a test can reach it (D133). What stays here is the operational half:
 * an error the vocabulary could not name is one an operator has to see, and
 * `signup-failed` is produced by nothing but that fallback.
 */
function codeFor(error: unknown): SignupErrorCode {
  const code = signupErrorCode(error);
  if (code === "signup-failed") console.error("[signup]", error);
  return code;
}

/**
 * `code` is a member of a literal union, so nothing a caller supplies can reach
 * the query string — that, and not escaping, is what keeps `?error=` inert.
 */
const back = (code: SignupErrorCode) => redirect(`/signup?error=${code}`);

export async function signUp(formData: FormData): Promise<void> {
  const name = String(formData.get("name") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");

  if (!name || !email || !password) back("missing-fields");

  try {
    await signUpWithWorkspace({ name, email, password });
  } catch (error) {
    // Nothing was left behind — the signup contract (D117) either builds the
    // user, the org and the workspace or none of them, so this is a retry, not
    // a half-finished account.
    back(codeFor(error));
  }

  redirect("/app");
}
