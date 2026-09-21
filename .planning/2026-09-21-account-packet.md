# Account packet — the signed-in person's own page (D707–D716)

**Date:** 2026-09-21. **Scope:** the parts of authentication and user profiles the
product had not closed: a person could sign up, sign in, invite and sign out, but
could not change their name, their sign-in address or their password, could not
see or end their own sessions, and could not see which organizations they belong
to. This packet closes those and writes down, as absences, what stays out and why.

## Inputs verified against the tree

- `server/auth.ts` (better-auth 1.7.1, email + password, `requireEmailVerification:
  false`, org plugin, `nextCookies` last; the D120 allowlist `{get-session,
  sign-out}` in `app/api/auth/[...all]/route.ts`; 52 mounted endpoints measured
  again with this packet's config change — unchanged).
- `server/session.ts` (`m.role = 'owner'` pin, D120; no switcher, D114/D228).
- `server/invites.ts` (in-process `auth.api.*` with the request's headers; the
  owner pin as a parameter, D148).
- `0003_auth.sql` — the captured schema: `user(name, email, image, emailVerified)`,
  `session(id, token, expiresAt, ipAddress, userAgent, userId)`, `account(password)`.
- The installed library, read: `routes/update-user.mjs` (`updateUser`,
  `changePassword`, `changeEmail`, `deleteUser`), `routes/session.mjs`
  (`listSessions` behind `freshSessionMiddleware`; `revokeSession` keyed by
  token), `context/create-context.mjs` (`freshAge` 24h, password bounds 8/128),
  `db/internal-adapter.mjs` (`createSession(userId)` records no IP/UA without a
  request), `routes/email-verification.mjs` (`createEmailVerificationToken`
  signs a JWT and writes no row).
- Measured with the repo's own tsx invocation: `/change-email` refuses a malformed
  address from its body schema before any session read, as `VALIDATION_ERROR`
  with the message prefix `[body.newEmail]`.

## Decisions

- **D707 — the account surface exists at `/app/account`, person-scoped.** Name,
  sign-in address, password, sessions and memberships; distinct from
  `/app/settings`, which is the workspace's. Live-wired exactly (`live-routes.ts`),
  reached from the account menu and the palette, and the drive's no-session probe
  covers it (D565). In mock mode it renders the D150 state — no form, the truth
  about the demo, two real pointers — inline, where the mock-mode shim can walk
  it; its five actions trip before the auth stack (D152).
- **D708 — every write is in-process or `$1`-bound; the allowlist does not move.**
  Name, address and password go through `auth.api.updateUser` / `changeEmail` /
  `changePassword` with the request's own headers (the invites shape). Sessions
  are listed and ended by statements on the captured `session` table.
  `/update-user`, `/change-email`, `/change-password`, `/list-sessions` and
  `/revoke-session` join the D120 matrix as NAMED stay-closed entries.
- **D709 — the email change needs two handler flags and no schema.**
  `user.changeEmail.enabled` and `updateEmailWithoutVerification`: every account
  here is unverified by construction (U4), and the library refuses an unverified
  account's direct change without the second flag. Neither is a field, so the
  captured DDL is unchanged and needs no re-capture; `auth.test.ts` pins both.
  The library's silent anti-enumeration answer for a taken address (`{status:
  true}`, row unchanged) is disambiguated by reading the row back and throwing
  `EmailTaken` — "updated" over an unchanged row is the D13 lie. The disclosure is
  the one `/signup` already makes (`exists`), behind D713's per-account limit.
- **D710 — the password change is the library's verify-then-hash; "sign out
  every other session" is obstack's own DELETE afterwards.** The library's
  `revokeOtherSessions: true` deletes the current row and re-creates it bare
  (no IP, no UA — `createSession(userId)` with no request), which would render
  this very session as "unknown browser" one paint later. The two steps are not
  one transaction, and the failure between them is stated: the refusal names the
  sessions step, the others stay listed, one button finishes the job.
- **D711 — sessions in SQL, never the token, ownership in the WHERE clause.**
  `/list-sessions` sits behind `freshSessionMiddleware` (a session older than
  24h cannot list itself) and `/revoke-session` is keyed by the bearer token, so
  the page reads `id, createdAt, expiresAt, ipAddress, userAgent` and nothing
  else, identifies a row by id, binds the caller's user id as the owner pin
  (`api-keys.ts`'s idiom), and excludes the current session by predicate — the
  top bar signs that one out. The store is the only session authority in this
  config (no cookie cache, no secondary storage), so an ended session is over on
  its next request; the integration test proves it on a real cookie.
- **D712 — two closed vocabularies on one page, section by prefix.** `?error=`
  and `?saved=` (D121 shape); a code's section is derived from its first word
  (`name`, `email`, `password`, `session(s)`), never carried in the URL; an
  unknown notice renders NOTHING (a claim about an outcome the vocabulary cannot
  name), an unknown error the generic sentence at the page level.
- **D713 — two budgets keyed by user id:** `password` 5 per 10 minutes (in front
  of the library's verify, after the shape checks that touch no secret) and
  `email` 5 per hour. The `mcp` precedent: a signed-in write is attributable to
  the account, and an IP-keyed budget would let one stolen cookie spend a NAT's
  worth of colleagues' attempts.
- **D714 — what stays out, written as absences.** Password reset (no email
  transport exists, so no link anyone could deliver; an owner-issued reset would
  let org A's owner take over an account that also belongs to org B). Account
  and organization deletion (the org, the workspace, the ClickHouse rows and a
  Polar subscription have no ruled fate; `user.deleteUser` stays unset so the
  library itself 404s the door). Avatar image (no upload path; a URL field would
  load a third party into every screen's chrome). The switcher (D228 stands).
  Member removal and role change (D148 stands). Each is on the absences page.
- **D715 — the docs.** `/docs/accounts-and-access` (registered, linked from the
  index) states the model; four absences join `/docs/what-obstack-does-not-do`;
  `mirror.test.ts` couples the page's numbers to the code (password bounds, the
  four rate limits, the 30-second revocation, the 48-hour invitation, the DDL's
  three scopes) and the absences to the config (`sendResetPassword` absent,
  `requireEmailVerification: false`, no `deleteUser` option, the owner pin).
- **D716 — the tests.** `account.test.ts` (no server: vocabularies, arms from
  real `APIError`s, total parses, statement shapes, the user-agent label);
  `account.integration.test.ts` (real Postgres: name, address, taken address,
  password rotation with the current row intact, sessions listed token-free and
  ended by id with the cookie dead on its next read, memberships after an
  accepted invitation) — it joins `auth.integration.test.ts`'s whole-table
  counts as the SECOND named sibling literal (`acct-it-`); the mock-mode shim
  gains the page and its five actions; `page.test.ts` pins the shape.

## Not done, and why

- **No e2e drive step.** The drive is the `e2e` job's critical path and is held
  under the ~6-minute line by ruling (D306(d)); a step could not be run here
  (no Docker daemon in this session) and would spend budget the packet has no
  measurement for. The registry-coverage check (D565) gains the route, which the
  drive's existing no-session probe exercises. A step that changes alice's name
  and password and signs in with both is the natural next arm, once measured.
- **No changelog entry.** An entry's date is the master merge date of the PR that
  made it true (D323), which does not exist until this merges.
