"use server";

import { normalizeWaitlistEmail } from "@/lib/waitlist";
import { addToWaitlist } from "@/server/waitlist";

/**
 * The one call `WaitlistForm` makes. A Server Function is reachable by a
 * direct POST and not only through the UI, so the address is validated HERE —
 * the input's `type="email"` is a convenience, not a boundary.
 *
 * The state is a member of a literal union the form maps to fixed copy, so
 * nothing a caller supplies is ever rendered back. `joined` deliberately does
 * not distinguish "was already on the list": the write is idempotent, and one
 * success message tells a prober nothing about which addresses are stored.
 */
export type WaitlistState = "idle" | "invalid-email" | "failed" | "joined";

export async function joinWaitlist(
  _prev: WaitlistState,
  formData: FormData,
): Promise<WaitlistState> {
  const email = normalizeWaitlistEmail(String(formData.get("email") ?? ""));
  if (email === null) return "invalid-email";

  try {
    await addToWaitlist(email);
  } catch (error) {
    // The address was valid and still didn't get stored — that is an operator's
    // problem (missing token, blob outage), so it must be visible in the logs.
    console.error("[waitlist]", error);
    return "failed";
  }
  return "joined";
}
