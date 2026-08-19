/**
 * The waitlist's input contract: what counts as an address worth storing, and
 * the one normalized form the store keys on. The Server Action validates with
 * this and the blob pathname is derived from its output, so "two spellings of
 * the same address" can only mean two records if this function says they
 * differ. Pure and client-safe so a test can hold both sides to the same
 * answer.
 */

/** RFC 5321's practical cap for a full address; longer strings are noise. */
export const WAITLIST_EMAIL_MAX_LENGTH = 254;

/**
 * One non-space local part, one `@`, one non-space domain with at least one
 * dot. Deliverability is proven by the invite email, not the regex, so this
 * only refuses what could never receive one.
 */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The stored form — trimmed, lowercased — or `null` for anything unsendable. */
export function normalizeWaitlistEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  if (email.length === 0 || email.length > WAITLIST_EMAIL_MAX_LENGTH) return null;
  return EMAIL_SHAPE.test(email) ? email : null;
}
