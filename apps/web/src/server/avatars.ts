import "server-only";
import { createHash } from "node:crypto";
import { AVATAR_MAX_BYTES, type AvatarType } from "@/lib/account-types";
import type { QueryRows } from "@/server/postgres";

/**
 * Avatars (D718): a person's picture, as the bytes they uploaded. The store is
 * `user_avatars` (0016) — one row per user, the type and the size CHECKed by
 * the DDL and mirrored by the parse here, the etag the SHA-256 of the bytes —
 * and the only reader is the route that serves it back
 * (`app/app/avatar/[userId]/route.ts`) to a signed-in viewer who is that
 * person or shares an organization with them: the roster is the one place
 * another person's picture appears, and a roster is exactly "who shares an
 * organization with me". Nothing here takes a viewer or a subject from a URL
 * without the session gate that route applies first; the user ids below are
 * the session's and the parsed path's, bound as parameters.
 *
 * Why bytes in Postgres and not a URL on the library's `user.image` column:
 * a URL field would load a third party's image into every screen's chrome for
 * everyone on the roster, and this deployment has no object store to point a
 * URL at. A 128-pixel picture is a few kilobytes; the cap below is many times
 * that, and it is the store's cap as well as this module's.
 */

/**
 * A user id off the route's path, as a total parse (D68): better-auth's row
 * ids are 32 characters of `[a-zA-Z0-9]` (`@better-auth/core/dist/utils/
 * id.mjs`), the same measurement `parseSessionId` rests on, and an id is only
 * ever bound as `$1` or compared. Anything else is not a person, and the route
 * answers 404 before it reads a row.
 */
const USER_ID = /^[A-Za-z0-9]{1,64}$/;

export function parseUserId(raw: string | undefined): string | null {
  if (typeof raw !== "string") return null;
  return USER_ID.test(raw) ? raw : null;
}

/**
 * The type is read off the bytes, never off the upload's declared name or
 * MIME: PNG's eight-byte signature, JPEG's SOI marker, WebP's RIFF container
 * with the WEBP form type. Anything else is not a picture this product stores,
 * whatever the browser called it.
 */
export function sniffImageType(bytes: Uint8Array): AvatarType | null {
  const at = (i: number) => bytes[i];
  if (
    bytes.length >= 8 &&
    at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47 &&
    at(4) === 0x0d && at(5) === 0x0a && at(6) === 0x1a && at(7) === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  if (
    bytes.length >= 12 &&
    String.fromCharCode(at(0), at(1), at(2), at(3)) === "RIFF" &&
    String.fromCharCode(at(8), at(9), at(10), at(11)) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

/** The upload is bigger than the store's CHECK admits. Named so `account/errors.ts` can select its sentence. */
export class AvatarTooLarge extends Error {
  constructor(size: number) {
    super(`avatar of ${size} bytes exceeds the ${AVATAR_MAX_BYTES}-byte cap`);
    this.name = "AvatarTooLarge";
  }
}

/** The upload's bytes are not a PNG, a JPEG or a WebP. */
export class AvatarNotImage extends Error {
  constructor() {
    super("the upload is not a PNG, JPEG or WebP image");
    this.name = "AvatarNotImage";
  }
}

/** The etag is the bytes' SHA-256, so equal pictures share one and a changed picture never reuses one. */
export function avatarEtag(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** What the writer stored, and what every renderer needs to name it. */
export interface StoredAvatar {
  contentType: AvatarType;
  etag: string;
}

const PUT_SQL = `
  INSERT INTO user_avatars (user_id, content_type, bytes, etag, updated_at)
  VALUES ($1, $2, $3, $4, now())
  ON CONFLICT (user_id) DO UPDATE
      SET content_type = EXCLUDED.content_type,
          bytes = EXCLUDED.bytes,
          etag = EXCLUDED.etag,
          updated_at = now()
  RETURNING etag`;

/**
 * Store a person's picture, replacing the one they had. Judged BEFORE the
 * write, in the order a reader would want to hear it: too big first (the
 * cheapest fact), then not-an-image; both are the store's own CHECKs stated
 * as classes, so a hand-crafted post that got past this parse would still be
 * refused by Postgres.
 */
export async function putAvatar(userId: string, bytes: Uint8Array, query: QueryRows): Promise<StoredAvatar> {
  if (bytes.length === 0 || bytes.length > AVATAR_MAX_BYTES) throw new AvatarTooLarge(bytes.length);
  const contentType = sniffImageType(bytes);
  if (!contentType) throw new AvatarNotImage();
  const etag = avatarEtag(bytes);
  await query(PUT_SQL, [userId, contentType, Buffer.from(bytes), etag]);
  return { contentType, etag };
}

const DELETE_SQL = `DELETE FROM user_avatars WHERE user_id = $1 RETURNING user_id`;

/** Remove the person's picture; answers whether there was one. */
export async function deleteAvatar(userId: string, query: QueryRows): Promise<boolean> {
  const rows = await query<{ user_id: string }>(DELETE_SQL, [userId]);
  return rows.length > 0;
}

const ETAGS_SQL = `SELECT user_id, etag FROM user_avatars WHERE user_id = ANY($1::text[])`;

/**
 * Which of these people have a picture, and the etag that names it — the read
 * every renderer makes (the shell for the viewer, the roster for its members,
 * the account page for its person). Ids only; the bytes never travel with a
 * page. The caller has already decided it may show these people — a roster is
 * the org's own members, the shell is the viewer — so no viewer predicate
 * applies here; the route that serves the bytes applies its own.
 */
export async function listAvatarEtags(userIds: string[], query: QueryRows): Promise<Map<string, string>> {
  if (userIds.length === 0) return new Map();
  const rows = await query<{ user_id: string; etag: string }>(ETAGS_SQL, [userIds]);
  return new Map(rows.map((row) => [row.user_id, row.etag]));
}

/** A picture as the route serves it. */
export interface AvatarBytes {
  contentType: AvatarType;
  bytes: Buffer;
  etag: string;
}

/**
 * The bytes, for a viewer who is the person ($1 = $2) or shares an
 * organization with them: the same two `member` rows the roster is built from,
 * joined on the organization. A stranger to every organization the person
 * belongs to gets null — the same nothing a user id that never existed gives,
 * so the route cannot be used to learn who has a picture.
 */
const READ_SQL = `
  SELECT a.content_type, a.bytes, a.etag
    FROM user_avatars a
   WHERE a.user_id = $1
     AND (
       $1 = $2
       OR EXISTS (
         SELECT 1
           FROM "member" mine
           JOIN "member" theirs ON theirs."organizationId" = mine."organizationId"
          WHERE mine."userId" = $2 AND theirs."userId" = $1
       )
     )`;

export async function readAvatarFor(
  userId: string,
  viewerUserId: string,
  query: QueryRows,
): Promise<AvatarBytes | null> {
  const [row] = await query<{ content_type: AvatarType; bytes: Buffer; etag: string }>(READ_SQL, [
    userId,
    viewerUserId,
  ]);
  if (!row) return null;
  return { contentType: row.content_type, bytes: row.bytes, etag: row.etag };
}
