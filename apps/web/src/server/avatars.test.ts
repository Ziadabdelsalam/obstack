import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { QueryResultRow } from "pg";
import { AVATAR_MAX_BYTES, avatarPath } from "@/lib/account-types";
import { HOSTILE_URL_VALUES } from "@/lib/hostile-url-values";
import type { QueryRows } from "./postgres";
import {
  AvatarNotImage,
  AvatarTooLarge,
  avatarEtag,
  deleteAvatar,
  listAvatarEtags,
  parseUserId,
  putAvatar,
  readAvatarFor,
  sniffImageType,
} from "./avatars";

// run with: npm test --workspace apps/web
//
// The avatar store with no server (D718): the type is read off the bytes, the
// cap and the type are judged before any statement, the etag is the bytes'
// hash, and the one read that serves bytes carries the viewer predicate in its
// own WHERE clause. The real-Postgres half — a colleague sees the picture, a
// stranger gets nothing, the DDL's CHECK refuses what the parse refuses — is
// `account.integration.test.ts`'s D718 leg.
delete process.env.BETTER_AUTH_SECRET;
delete process.env.OBSTACK_POSTGRES_DSN;

type Statement = { sql: string; params?: unknown[] };

function recordingQuery(rows: unknown[]) {
  const seen: Statement[] = [];
  const query: QueryRows = async <Row extends QueryResultRow>(
    sql: string,
    params: unknown[] = [],
  ): Promise<Row[]> => {
    seen.push({ sql, params });
    return rows as Row[];
  };
  return { query, seen };
}

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const WEBP = Uint8Array.from([...Buffer.from("RIFF"), 0x24, 0, 0, 0, ...Buffer.from("WEBP"), ...Buffer.from("VP8 ")]);
const GIF = Uint8Array.from(Buffer.from("GIF89a"));

test("the type is read off the bytes: PNG, JPEG and WebP signatures, nothing else", () => {
  assert.equal(sniffImageType(PNG), "image/png");
  assert.equal(sniffImageType(JPEG), "image/jpeg");
  assert.equal(sniffImageType(WEBP), "image/webp");
  assert.equal(sniffImageType(GIF), null, "a GIF is not a type the store admits");
  assert.equal(sniffImageType(new Uint8Array()), null);
  assert.equal(sniffImageType(PNG.slice(0, 7)), null, "seven bytes of a PNG signature are not a PNG");
  assert.equal(sniffImageType(Uint8Array.from(Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\"/>"))), null, "an SVG is script, not a picture");
  // RIFF without the WEBP form type is some other container (a WAV, say)
  assert.equal(sniffImageType(Uint8Array.from([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WAVE")])), null);
});

test("D68: parseUserId is total, and its answer is always an id or nothing", () => {
  const REAL = "aB3xQ7zLmN0pR5tV9wY2cD4fG6hJ8kS1";
  assert.equal(parseUserId(REAL), REAL);
  for (const value of HOSTILE_URL_VALUES) {
    const parsed = parseUserId(value as unknown as string);
    if (parsed !== null) assert.match(parsed, /^[A-Za-z0-9]{1,64}$/, `escaped the id domain: ${parsed}`);
  }
  for (const refused of ["", "__proto__", "x".repeat(65), "%00", "a/b", "a b", "a-b", "a.b", "user_1"]) {
    assert.equal(parseUserId(refused), null, `accepted ${JSON.stringify(refused)}`);
  }
  assert.equal(parseUserId(undefined), null);
});

test("the etag is the bytes' SHA-256, and the path carries it as the cache-busting query", () => {
  assert.equal(avatarEtag(PNG), createHash("sha256").update(PNG).digest("hex"));
  assert.notEqual(avatarEtag(PNG), avatarEtag(JPEG));
  assert.equal(avatarPath("user-1", "abc123"), "/app/avatar/user-1?v=abc123");
  // encoded, so a value outside the id alphabet cannot break out of the path
  assert.equal(avatarPath("a/b", "c?d"), "/app/avatar/a%2Fb?v=c%3Fd");
});

test("D718: an upload is judged before any statement — the cap first, then the type", async () => {
  const tooBig = new Uint8Array(AVATAR_MAX_BYTES + 1);
  tooBig.set(PNG);
  const big = recordingQuery([]);
  await assert.rejects(putAvatar("user-1", tooBig, big.query), AvatarTooLarge);
  assert.equal(big.seen.length, 0, "an oversize upload must never reach the store");

  const empty = recordingQuery([]);
  await assert.rejects(putAvatar("user-1", new Uint8Array(), empty.query), AvatarTooLarge);
  assert.equal(empty.seen.length, 0);

  const notImage = recordingQuery([]);
  await assert.rejects(putAvatar("user-1", GIF, notImage.query), AvatarNotImage);
  assert.equal(notImage.seen.length, 0, "a non-image must never reach the store");

  // exactly the cap is admitted: the CHECK is BETWEEN 1 AND the cap
  const atCap = new Uint8Array(AVATAR_MAX_BYTES);
  atCap.set(JPEG);
  const ok = recordingQuery([{ etag: "x" }]);
  const stored = await putAvatar("user-1", atCap, ok.query);
  assert.equal(stored.contentType, "image/jpeg");
  assert.equal(stored.etag, avatarEtag(atCap));
});

test("D718: the write is one upsert keyed by the user, the bytes bound as a Buffer", async () => {
  const { query, seen } = recordingQuery([{ etag: avatarEtag(PNG) }]);
  await putAvatar("user-1", PNG, query);
  assert.equal(seen.length, 1);
  assert.match(seen[0].sql, /INSERT INTO user_avatars \(user_id, content_type, bytes, etag, updated_at\)/);
  assert.match(seen[0].sql, /ON CONFLICT \(user_id\) DO UPDATE/);
  assert.equal(seen[0].params?.[0], "user-1");
  assert.equal(seen[0].params?.[1], "image/png");
  assert.ok(Buffer.isBuffer(seen[0].params?.[2]), "bytea is bound as a Buffer, never interpolated");
  assert.equal(seen[0].params?.[3], avatarEtag(PNG));
});

test("delete answers whether a row went, and the etag list asks for ids only", async () => {
  const gone = recordingQuery([{ user_id: "user-1" }]);
  assert.equal(await deleteAvatar("user-1", gone.query), true);
  assert.match(gone.seen[0].sql, /DELETE FROM user_avatars WHERE user_id = \$1 RETURNING user_id/);
  const none = recordingQuery([]);
  assert.equal(await deleteAvatar("user-1", none.query), false);

  const list = recordingQuery([{ user_id: "user-2", etag: "e2" }]);
  const etags = await listAvatarEtags(["user-1", "user-2"], list.query);
  assert.match(list.seen[0].sql, /SELECT user_id, etag FROM user_avatars WHERE user_id = ANY\(\$1::text\[\]\)/);
  assert.doesNotMatch(list.seen[0].sql, /bytes/, "the etag list must never carry the bytes onto a page");
  assert.deepEqual(list.seen[0].params, [["user-1", "user-2"]]);
  assert.deepEqual([...etags.entries()], [["user-2", "e2"]]);

  // no ids, no statement
  const empty = recordingQuery([]);
  assert.deepEqual([...(await listAvatarEtags([], empty.query)).entries()], []);
  assert.equal(empty.seen.length, 0);
});

test("D718: the one read that serves bytes carries the viewer predicate in its own WHERE clause", async () => {
  const bytes = Buffer.from(PNG);
  const { query, seen } = recordingQuery([{ content_type: "image/png", bytes, etag: "e1" }]);
  const avatar = await readAvatarFor("user-1", "viewer-9", query);

  const { sql, params } = seen[0];
  assert.match(sql, /FROM user_avatars a/);
  assert.match(sql, /WHERE a\.user_id = \$1/);
  // the person themselves, or someone on a roster with them — the same two
  // member rows the roster is built from, joined on the organization
  assert.match(sql, /\$1 = \$2/);
  assert.match(sql, /FROM "member" mine\s+JOIN "member" theirs ON theirs\."organizationId" = mine\."organizationId"/);
  assert.match(sql, /WHERE mine\."userId" = \$2 AND theirs\."userId" = \$1/);
  assert.deepEqual(params, ["user-1", "viewer-9"]);
  assert.deepEqual(avatar, { contentType: "image/png", bytes, etag: "e1" });

  const none = recordingQuery([]);
  assert.equal(await readAvatarFor("user-1", "stranger", none.query), null);
});
