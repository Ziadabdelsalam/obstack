import assert from "node:assert/strict";
import test from "node:test";

// run with: npm test --workspace apps/web
//
// D114's byte-invariance from the shell's side. The app layout's live-mode
// guard imports the session helper and the auth instance at module scope, so
// mock mode now has to survive LOADING that graph with no Postgres and no
// secret present at all — the demo product runs on a machine that has neither.
// `server/tenancy.test.ts` holds the other half (mock mode never CALLS them).
//
// The layout module itself cannot be imported here and this file deliberately
// does not try: under `--conditions react-server` React has no `createContext`,
// so `next/link` throws at module scope and no component module in this app
// loads at all (apps/web/package.json's `//test` note). What a test CAN hold is
// the server graph the guard drags in behind it, which is the half that could
// stop a database-less boot. "mock mode renders" is proven where it is real —
// against a mock-mode production serve with these variables unset.
delete process.env.OBSTACK_POSTGRES_DSN;
delete process.env.BETTER_AUTH_SECRET;
delete process.env.CLICKHOUSE_URL;
delete process.env.OBSTACK_DATA_MODE;

test("this process really has no Postgres and no auth secret", async () => {
  // The falsification probe (S2.2 L1): everything below is a claim about
  // running WITHOUT those two, so they must be genuinely unreachable here — a
  // pool that could still connect would make "mock mode booted anyway" prove
  // nothing. Both refusals name the variable they want, which is also what a
  // live deployment gets when it forgets one.
  const { getPool } = await import("@/server/postgres");
  assert.throws(getPool, /OBSTACK_POSTGRES_DSN is required/);
  const { authConfig } = await import("@/server/auth");
  assert.throws(authConfig, /BETTER_AUTH_SECRET is required/);
});

test("mock mode boots with the guard's whole server graph loaded (D114)", async () => {
  // The layout's imports minus the component tree: the facade it reads the
  // mode from, the session helper its guard calls, and the auth instance the
  // account line reads. Loading all three must cost nothing — a pool opened or
  // a `betterAuth()` built at module scope would take the demo product down on
  // the machine that has no database, and neither import below would survive.
  const data = await import("@/server/data");
  await import("@/server/session");
  await import("@/server/auth");
  assert.equal(data.dataMode, "mock");

  // And the mode check still short-circuits ahead of any session work: the
  // guard's `live` is false here, so the shell resolves its reads without one.
  const facade = await data.dataForSession();
  assert.equal(facade.workspaceId, null, "mock mode has no tenant to name");
  assert.ok((await facade.searchTraces()).traces.length > 0);
});
