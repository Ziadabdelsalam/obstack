import { toNextJsHandler } from "better-auth/next-js";
import { getAuth } from "@/server/auth";

/**
 * better-auth mounts 52 endpoints under this segment at 1.7.1 — sign-up, org
 * create/delete/update, invitation accept, member removal, session revocation,
 * the lot. A browser in this product needs exactly two of them, so this is an
 * ALLOWLIST rather than a list of doors to shut (D120): an upgrade that adds an
 * endpoint adds it CLOSED, and nobody has to notice.
 *
 * Everything refused here has a server action that owns the invariant the raw
 * endpoint would break — signup by the transaction that also makes the org and
 * the workspace (D117), sign-in by the login action, and the five invitation
 * endpoints by `server/invites.ts`, which calls them in-process with the
 * request's headers and fills `organizationId` from the session's owner pin
 * rather than from a body (D143/D148).
 *
 * S3.2 therefore opens ZERO doors: this set is byte-identical to the one S3.1
 * left, and `/organization/invite-member`, `/cancel-invitation`,
 * `/accept-invitation`, `/get-invitation` and `/list-invitations` join the D120
 * matrix as NAMED stay-closed entries — asserted 404 with a real session and a
 * real pending invitation, and zero row deltas, in
 * `server/invites.integration.test.ts`, against bodies the same file proves are
 * live ammunition by firing them with the guard bypassed.
 */
const ALLOWED_ENDPOINTS = new Set(["get-session", "sign-out"]);

const MOUNT = "/api/auth/";

/** What a refused endpoint says: the truth, plus where the two real doors are. */
const REFUSAL = {
  message: "Not mounted. obstack serves get-session and sign-out here; sign up at /signup, sign in at /login.",
};

/**
 * The endpoint this request is really for, or `null` when it is not a request
 * to this mount at all. `new URL` normalises `.` and `..` segments before the
 * comparison, decoding closes `sign-up%2Femail`, the trailing-slash strip and
 * the lowercase close the spelling variants, and a malformed escape is refused
 * rather than guessed at — the allowlist has to be total over the ways a path
 * can be written, not just over the way better-auth writes it.
 */
function endpointOf(url: string): string | null {
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(url).pathname);
  } catch {
    return null;
  }
  if (!pathname.startsWith(MOUNT)) return null;
  return pathname.slice(MOUNT.length).replace(/\/+$/, "").toLowerCase();
}

/** Exported for the D120 matrix test, which asserts the allowlist over every mounted path. */
export function isAllowedEndpoint(url: string): boolean {
  return ALLOWED_ENDPOINTS.has(endpointOf(url) ?? "");
}

/**
 * The handler is resolved per request rather than at module load so that a
 * mock-mode build, which has no Postgres and no secret, still compiles this
 * route (D114) — and so that a refused request never constructs it at all,
 * which is what makes "refused means zero rows touched" a fact rather than a
 * hope.
 */
const handler = toNextJsHandler((request: Request) => getAuth().handler(request));

export async function GET(request: Request): Promise<Response> {
  if (!isAllowedEndpoint(request.url)) return Response.json(REFUSAL, { status: 404 });
  return handler.GET(request);
}

export async function POST(request: Request): Promise<Response> {
  if (!isAllowedEndpoint(request.url)) return Response.json(REFUSAL, { status: 404 });
  return handler.POST(request);
}
