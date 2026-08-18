-- better-auth's own schema, CAPTURED — never applied by the library (D95/D117).
-- Everything below this header is the verbatim output of better-auth 1.7.1's
-- generate path (only a closing newline was added); the ingest binary applies
-- it in filename order with the workspaces and saved_views above.
--
-- @better-auth/cli is NOT the generator here: its newest release (1.4.21)
-- depends on better-auth 1.4.21 and would emit that version's schema for a
-- config the app runs on 1.7.1. `getMigrations().compileMigrations()` is the
-- same call the CLI's `generate` prints from, taken from the installed 1.7.1.
--
-- To re-capture after changing `apps/web/src/server/auth.ts` (the config below
-- is generated FROM it, so an option change without a re-capture is drift):
--
--   docker run --rm -d --name obstack-authgen -p 55432:5432 \
--     -e POSTGRES_USER=obstack -e POSTGRES_PASSWORD=obstack_postgres_dev \
--     -e POSTGRES_DB=obstack postgres:17.11
--   cat > apps/web/authgen.ts <<'EOF'
--   import { getMigrations } from "better-auth/db/migration";
--   import { authConfig } from "@/server/auth";
--   getMigrations(authConfig()).then(async (m) => {
--     process.stdout.write(await m.compileMigrations());
--     process.exit(0);
--   });
--   EOF
--   OBSTACK_POSTGRES_DSN=postgres://obstack:obstack_postgres_dev@127.0.0.1:55432/obstack \
--   BETTER_AUTH_SECRET=any-non-empty-value TSX_TSCONFIG_PATH=apps/web/tsconfig.json \
--     npx tsx --conditions react-server apps/web/authgen.ts
--   rm apps/web/authgen.ts && docker rm -f obstack-authgen
--
-- The generate path introspects the target database and emits only what is
-- missing, so it must run against an EMPTY one or it prints nothing.
--
-- `invitation` is created and unused: invites are S3.2 (scope fence). It is
-- part of the organization plugin's schema, not a table we chose.

create table "user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" boolean not null, "image" text, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz default CURRENT_TIMESTAMP not null);

create table "session" ("id" text not null primary key, "expiresAt" timestamptz not null, "token" text not null unique, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz not null, "ipAddress" text, "userAgent" text, "userId" text not null references "user" ("id") on delete cascade, "activeOrganizationId" text);

create table "account" ("id" text not null primary key, "issuer" text not null, "accountId" text not null, "providerId" text not null, "userId" text not null references "user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" timestamptz, "refreshTokenExpiresAt" timestamptz, "scope" text, "password" text, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz not null);

create table "verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" timestamptz not null, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz default CURRENT_TIMESTAMP not null);

create table "organization" ("id" text not null primary key, "name" text not null, "slug" text not null unique, "logo" text, "createdAt" timestamptz not null, "metadata" text);

create table "member" ("id" text not null primary key, "organizationId" text not null references "organization" ("id") on delete cascade, "userId" text not null references "user" ("id") on delete cascade, "role" text not null, "createdAt" timestamptz not null);

create table "invitation" ("id" text not null primary key, "organizationId" text not null references "organization" ("id") on delete cascade, "email" text not null, "role" text, "status" text not null, "expiresAt" timestamptz not null, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "inviterId" text not null references "user" ("id") on delete cascade);

create index "session_userId_idx" on "session" ("userId");

create index "account_userId_idx" on "account" ("userId");

create index "verification_identifier_idx" on "verification" ("identifier");

create index "member_organizationId_idx" on "member" ("organizationId");

create index "member_userId_idx" on "member" ("userId");

create index "invitation_organizationId_idx" on "invitation" ("organizationId");

create index "invitation_email_idx" on "invitation" ("email");

create unique index "account_issuer_accountId_uidx" on "account" ("issuer", "accountId");
