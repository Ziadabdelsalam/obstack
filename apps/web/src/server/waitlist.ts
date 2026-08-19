import "server-only";
import { createHash } from "node:crypto";
import { put } from "@vercel/blob";

/**
 * The waitlist store: one private JSON blob per address in the
 * `obstack-waitlist` Vercel Blob store (BLOB_READ_WRITE_TOKEN), at
 * `waitlist/<sha256(email)>.json`.
 *
 * The pathname is derived from the normalized address, and the write
 * overwrites in place, so submitting twice refreshes one record instead of
 * appending a second — dedupe by construction, not by read-before-write.
 * Addresses are PII: the store is private-access, so a blob URL that leaks
 * does not serve the email behind it.
 */
export async function addToWaitlist(email: string): Promise<void> {
  const key = createHash("sha256").update(email).digest("hex");
  await put(
    `waitlist/${key}.json`,
    JSON.stringify({ email, joinedAt: new Date().toISOString() }),
    {
      access: "private",
      contentType: "application/json",
      addRandomSuffix: false,
      allowOverwrite: true,
    },
  );
}
