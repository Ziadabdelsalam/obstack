"use server";

import { redirect } from "next/navigation";
import { getAuth } from "@/server/auth";
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
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");

  if (!email || !password) back("missing-fields");

  try {
    await getAuth().api.signInEmail({ body: { email, password } });
  } catch (error) {
    back(codeFor(error));
  }

  redirect("/app");
}
