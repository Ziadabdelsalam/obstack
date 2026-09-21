import { parseUserId, readAvatarFor } from "@/server/avatars";
import { dataMode } from "@/server/data";
import { queryRows } from "@/server/postgres";
import { getSessionContext } from "@/server/session";

/**
 * A person's picture (D718), served to a signed-in viewer who is that person
 * or shares an organization with them — the predicate is the store's
 * (`server/avatars.ts`'s `readAvatarFor`), and a viewer outside it gets the
 * same 404 a user id that never existed gives, so this route cannot be used
 * to learn who has a picture.
 *
 * It is an image request, not a navigation, so its refusals are status codes
 * with no body (the quickstart poll's D216 shape): a login page rendered into
 * an `<img>` would be a broken picture with a redirect behind it. `private`
 * caching with a day's max-age is safe because the URL carries the etag
 * (`avatarPath`): the bytes behind one URL never change, a new picture is a
 * new URL, and a shared cache never sees a picture at all. `If-None-Match`
 * answers 304 from the etag alone, without reading the bytes back out.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ userId: string }> },
): Promise<Response> {
  // Mock mode has no accounts and renders initials everywhere, so a request
  // here came from somewhere no visitor can be — 404, plus the tripwire log
  // (D193: it cannot occur through honest use).
  if (dataMode === "mock") {
    console.error("[avatar] requested in mock mode — this deployment keeps no accounts");
    return new Response(null, { status: 404 });
  }

  const session = await getSessionContext();
  if (!session) return new Response(null, { status: 401 });

  const userId = parseUserId((await params).userId);
  if (!userId) return new Response(null, { status: 404 });

  const avatar = await readAvatarFor(userId, session.userId, queryRows);
  if (!avatar) return new Response(null, { status: 404 });

  const etag = `"${avatar.etag}"`;
  const cacheControl = "private, max-age=86400";
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { etag, "cache-control": cacheControl } });
  }
  return new Response(new Uint8Array(avatar.bytes), {
    status: 200,
    headers: {
      "content-type": avatar.contentType,
      "content-length": String(avatar.bytes.length),
      "content-disposition": "inline",
      "x-content-type-options": "nosniff",
      "cache-control": cacheControl,
      etag,
    },
  });
}
