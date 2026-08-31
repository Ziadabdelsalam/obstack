import "server-only";
import { randomBytes } from "node:crypto";
import { betterAuth } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import { organization } from "better-auth/plugins/organization";
import { getPool, queryRows, type SqlClient } from "@/server/postgres";
import { RateLimitedError, checkRateLimit, getClientIp } from "@/server/rate-limit";

/**
 * better-auth, email + password, no email verification (U4). The organization
 * plugin supplies the org tables and the invitation endpoints `server/invites.ts`
 * calls in-process (D143) — none of which is mounted for a browser, and none of
 * which needed an option added here: `sendInvitationEmail` is optional and stays
 * unset, because S3.2's invites are copyable links rather than mail.
 *
 * The library never touches the schema: its DDL was captured through the
 * generate path into `services/ingest/pgmigrations/0003_auth.sql`, which the
 * ingest binary applies alongside our own tables (D95/D117). That file's header
 * carries the exact command that regenerates it FROM THIS CONFIG — the config
 * and the checked-in SQL are one definition, and they drift the moment an
 * option below changes without a re-capture.
 */
export function authConfig() {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) throw new Error("BETTER_AUTH_SECRET is required when OBSTACK_DATA_MODE=live");
  return {
    database: getPool(),
    secret,
    emailAndPassword: { enabled: true, requireEmailVerification: false },
    // nextCookies stays last: it is the after-hook that writes the session
    // cookie through `next/headers`, and better-auth warns when a cookie
    // plugin is not the final entry.
    plugins: [organization(), nextCookies()],
    // D359: staging measured better-auth's OWN limiter — the mounted HTTP
    // router (`get-session`/`sign-out`), never the in-process signup/login
    // path D339 already owns — warning "Rate limiting could not determine a
    // client IP and is falling back to a single shared per-path bucket"
    // (`node_modules/better-auth/dist/api/rate-limiter/index.mjs:242`) and
    // writing an empty `ipAddress` on session rows. That single shared bucket
    // is a latent outage: its default is 100 requests / 10 s for ALL signed-in
    // traffic combined, not per visitor.
    //
    // `ipAddressHeaders` names which header(s) to read, in order; unset it
    // already defaults to `["x-forwarded-for"]`
    // (`node_modules/@better-auth/core/dist/utils/ip.mjs:194`,
    // `const DEFAULT_IP_HEADERS = ["x-forwarded-for"];`) — so the warning was
    // never a missing-header problem. Setting it here anyway makes the choice
    // an explicit, pinned decision (`auth.test.ts`'s D359 pin) rather than an
    // inherited library default that could change under us.
    //
    // The actual hop-selection is the library's own, and this repo does not
    // configure `trustedProxies` (Railway's edge IP ranges are not
    // documented — S5 kickoff R2 — and a wrong CIDR here is worse than none).
    // Per the installed build, WITHOUT `trustedProxies` a forwarded header
    // must carry exactly one value or the address is treated as unresolved:
    // `if (forwardedIps.length !== 1) return null;`
    // (`node_modules/@better-auth/core/dist/utils/ip.mjs:188`) — so this
    // resolves the client IP when Railway's edge writes a single-value
    // `x-forwarded-for`, and preserves today's fail-open warn-once behaviour
    // (`resolveRateLimitConfig`, `rate-limiter/index.mjs:232-236`) rather than
    // trusting an arbitrary hop if that header ever carries a chain instead.
    //
    // This is entirely separate from — and unchanged by — obstack's own D339
    // limiter in `server/rate-limit.ts`: that one guards the two in-process
    // signup/login calls this HTTP router never reaches, and reads its IP via
    // `clientIpFromForwarded` (`rate-limit.ts`, rightmost hop per F-T8a), not through better-auth at all.
    advanced: {
      ipAddress: {
        ipAddressHeaders: ["x-forwarded-for"],
      },
    },
  };
}

function createAuth() {
  return betterAuth(authConfig());
}

let auth: ReturnType<typeof createAuth> | undefined;

/**
 * The auth instance, built on first use. Lazy for D114's byte-invariance: mock
 * mode reaches neither this nor the pool `authConfig` opens.
 */
export function getAuth(): ReturnType<typeof createAuth> {
  if (!auth) auth = createAuth();
  return auth;
}

/** Signup failed and left nothing behind — the visible half of the D117 property. */
export class SignupError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SignupError";
  }
}

/**
 * A new org's slug is its id. `organization.slug` is UNIQUE, and a slug derived
 * from a name or an email local part would let one stranger's signup fail
 * because another stranger picked the same word first. S3.2's invite links are
 * `/invite/<invitation.id>` (D143), so there is still no org-facing URL to spend
 * a readable slug on — the org's NAME is what the invite surfaces show.
 */
const ORG_SQL = `INSERT INTO "organization" (id, name, slug, "createdAt") VALUES ($1, $2, $1, now())`;
const MEMBER_SQL = `INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt") VALUES ($1, $2, $3, 'owner', now())`;
const WORKSPACE_SQL = `INSERT INTO workspaces (id, org_id) VALUES ($1, $2)`;

const id = (prefix: string) => `${prefix}_${randomBytes(8).toString("hex")}`;

/**
 * D117's signup contract, as a property rather than a sequence: the org, its
 * owner membership and the org's one workspace land in ONE transaction — all
 * three or none — and a user those three cannot be built for is removed again
 * before the failure is raised. There is no third outcome, so no half-signed-up
 * stranger can reach the product.
 *
 * `workspaces.org_id` carries no foreign key to the library-shaped org table
 * (D112), so this transaction IS the integrity — which is why the workspace
 * INSERT lives inside it rather than after it.
 *
 * `removeUser` is a parameter because better-auth has no transaction to enlist
 * in: its `create.after` database hooks are queued past the commit
 * (`queueAfterTransactionHook` in @better-auth/core), so the user row is
 * already durable by the time this runs. D117's ruled fallback is exactly this
 * compensation — and passing it in is what lets the contract be proven on both
 * legs without a server (`auth.test.ts`).
 */
export async function provisionOrgAndWorkspace(
  client: SqlClient,
  userId: string,
  orgName: string,
  removeUser: (userId: string) => Promise<void>,
): Promise<{ orgId: string; workspaceId: string }> {
  const orgId = id("org");
  const workspaceId = id("ws");
  try {
    await client.query("BEGIN");
    await client.query(ORG_SQL, [orgId, orgName]);
    await client.query(MEMBER_SQL, [id("mem"), orgId, userId]);
    await client.query(WORKSPACE_SQL, [workspaceId, orgId]);
    await client.query("COMMIT");
  } catch (error) {
    // A ROLLBACK that itself fails means the connection is gone, which already
    // ended the transaction — the statement that failed is the reportable one.
    await client.query("ROLLBACK").catch(() => undefined);
    try {
      await removeUser(userId);
    } catch (cleanupError) {
      throw new SignupError(
        `signup failed and the user ${userId} it created could not be removed`,
        { cause: cleanupError },
      );
    }
    throw new SignupError("signup failed: the org and workspace could not be created", {
      cause: error,
    });
  }
  return { orgId, workspaceId };
}

/** Sessions and accounts follow the user row out through the captured schema's ON DELETE CASCADE. */
async function deleteUser(userId: string): Promise<void> {
  await queryRows(`DELETE FROM "user" WHERE id = $1`, [userId]);
}

/**
 * D339: obstack's own abuse control, ahead of better-auth's own signup call —
 * `server/rate-limit.ts`'s header comment names why the library's limiter
 * never reaches this path. A refusal throws `RateLimitedError` rather than
 * `SignupError` (F1): `signup/errors.ts`'s `signupErrorCode` recognises it
 * by `instanceof` and answers its own "Too many attempts..." member, instead
 * of the generic `signup-failed` every other failure in this boundary falls
 * through to.
 */
async function assertNotRateLimited(): Promise<void> {
  const ip = await getClientIp();
  if (!checkRateLimit("signup", ip)) {
    throw new RateLimitedError("signup");
  }
}

/** Signup: better-auth makes the user and the session cookie, the transaction above makes the tenant. */
export async function signUpWithWorkspace(input: {
  name: string;
  email: string;
  password: string;
}): Promise<{ orgId: string; workspaceId: string }> {
  await assertNotRateLimited();

  const { user } = await getAuth().api.signUpEmail({
    body: { name: input.name, email: input.email, password: input.password },
  });

  const client = await getPool().connect();
  try {
    return await provisionOrgAndWorkspace(client, user.id, input.name, deleteUser);
  } finally {
    client.release();
  }
}
