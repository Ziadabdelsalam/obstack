"use server";

import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { dataMode } from "@/server/data";
import { acceptInvite, inviteLinkPath, parseInvitationId } from "@/server/invites";
import { inviteErrorCode, type InviteErrorCode } from "./errors";

/**
 * Same split as signup's and login's: `errors.ts` names the failure, this
 * surface logs the ones it could not name. A generic answer here means a
 * library code the vocabulary has never seen — including the emailVerified
 * guard, which cannot fire in this config and would be a ruling to revisit if it
 * did (D143's escalation list).
 */
function codeFor(error: unknown): InviteErrorCode {
  const code = inviteErrorCode(error);
  if (code === "invite-failed") console.error("[invite]", error);
  return code;
}

/**
 * Accept the invitation named by the form. A Server Function is reachable by a
 * direct POST and not only through the page (Next's own warning), so the id is
 * re-parsed here rather than trusted from the render that produced the form —
 * and the redirect target is built from the PARSED value, which is why nothing a
 * caller writes can reach a `Location` header.
 *
 * `notFound()` for an id that is not an id: there is no `/invite/<id>` page to
 * send such a request back to, and inventing one out of the raw input is exactly
 * the reflection the parse exists to stop.
 *
 * Success redirects back to the same link, with no parameter. The page reads the
 * joined state from the store, so the "you've joined" surface is a fact about
 * rows rather than a claim carried in a query string (D149's no-`?next=` posture,
 * applied to success too).
 */
export async function acceptInvitation(formData: FormData): Promise<void> {
  const id = parseInvitationId(String(formData.get("invitationId") ?? ""));
  if (!id) notFound();

  // Signup's and login's tripwire, third instance (D150/D152): mock mode has no
  // accounts, so the page above this form renders its honest state instead of a
  // form and nothing can legitimately post here. The refusal is a send-back to
  // that state — built from the PARSED id like every other exit from this
  // function — and it happens before `acceptInvite`, the one line below that
  // builds the auth instance and opens a pool. No error code: the vocabulary
  // answers a real attempt, and this is not one.
  if (dataMode === "mock") {
    console.error("[invite] accept posted in mock mode — this deployment keeps no accounts");
    redirect(inviteLinkPath(id));
  }

  try {
    await acceptInvite(id, await headers());
  } catch (error) {
    redirect(`${inviteLinkPath(id)}?error=${codeFor(error)}`);
  }

  redirect(inviteLinkPath(id));
}
