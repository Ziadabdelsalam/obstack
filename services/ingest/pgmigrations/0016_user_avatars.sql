-- Avatars (D718): a person's picture, stored as the bytes they uploaded and
-- served back by `apps/web/src/app/app/avatar/[userId]/route.ts` to signed-in
-- viewers who share an organization with them. The bytes live HERE rather than
-- behind a URL on the library's `user.image` column: a URL field would load a
-- third party's image into every screen's chrome, and there is no object store
-- in this deployment to point one at. The size and the type are CHECKs the
-- store keeps (0002's rule: the DDL is the authority, the web's parse mirrors
-- it) — 256 KiB is enough for a 128-pixel picture many times over, and the
-- three types are the ones a browser can decode without help. The etag is the
-- SHA-256 of the bytes, computed by the writer and used by the route for
-- conditional requests and by every renderer as the cache-busting query.
--
-- user_id is a soft TEXT reference to the library-shaped "user" table (D112);
-- there is nothing in-set to cascade from, so a deleted user's row is removed
-- by whoever deletes the user (the integration tests do it by id).
CREATE TABLE IF NOT EXISTS user_avatars
(
    user_id      TEXT PRIMARY KEY,
    content_type TEXT NOT NULL
        CONSTRAINT user_avatars_content_type_check CHECK (content_type IN ('image/png', 'image/jpeg', 'image/webp')),
    bytes        BYTEA NOT NULL
        CONSTRAINT user_avatars_bytes_check CHECK (octet_length(bytes) BETWEEN 1 AND 262144),
    etag         TEXT NOT NULL CHECK (etag <> ''),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
