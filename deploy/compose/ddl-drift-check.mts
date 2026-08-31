/**
 * D122: the captured better-auth DDL and the config it was generated from are
 * ONE definition, and this is the question that keeps them one.
 *
 * `services/ingest/pgmigrations/0003_auth.sql` is the verbatim output of
 * better-auth's generate path run against `authConfig()`
 * (apps/web/src/server/auth.ts). Nothing in the library re-checks that: change
 * a plugin or a field on the config without re-capturing and the app's tables
 * silently stop matching the migration the ingest binary applies. So this
 * regenerates the DDL from the config the app actually runs and diffs it
 * against the checked-in file's non-comment body.
 *
 * The generator introspects its target and emits only what is MISSING, so it
 * has to see an empty database — hence the throwaway scratch database created
 * and dropped around the capture, on the compose Postgres (D112(b)) rather
 * than any product database.
 *
 * That teardown's ORDER is load-bearing, and getting it wrong killed a real CI
 * run (S4.3 recorded it as latent; PR #24's `e2e` runner hit it on node 24).
 * `Pool.end()` resolves BEFORE its sockets are closed: pg-pool fires the end
 * callback the moment `_clients` empties, which happens in the same tick
 * `client.end()` is merely STARTED (pg-pool/index.js:133-142,172-186). Dropping
 * the scratch database `WITH (FORCE)` right after therefore terminated backends
 * that were still alive, and the resulting 57P01 ("terminating connection due
 * to administrator command") landed on a client pg-pool had already removed but
 * whose `idleListener` was still attached — and that listener re-emits on the
 * POOL (`:62`), which carried no `'error'` listener. Node then threw out of the
 * event loop, where `main().catch` below cannot reach it: the guard died before
 * the diff, printing no verdict. It was never a node-version bug, only a race
 * that node 22 lost more often.
 *
 * Both halves are closed here. Every Pool and Client this script touches — the
 * admin connection, and BOTH lazy pool singletons the capture can run on (see
 * the loop in main(): the config's and this file's own import's are different
 * objects under `--conditions react-server`) — carries a no-op `'error'`
 * listener from before its first client exists, so no pg error can reach Node's
 * unhandled path however late it arrives. And the drop no longer needs FORCE:
 * the pools are ended, then whatever remains attached to the scratch database
 * is terminated explicitly and awaited, so a plain DROP has nothing left to
 * kill. Neither half depends on timing.
 *
 * And the teardown cannot speak over the capture. Every step in that `finally`
 * runs through `bestEffort` (below): a `query()` on an admin connection that
 * died with the pools rejects — `server.on('error')` handles the socket EVENT,
 * not the promise — and a bare `await` there would have replaced the drift
 * verdict with the story of its own cleanup, then skipped the DROP and
 * `server.end()` on the way out, orphaning the scratch database. Guarded, each
 * step still gets its turn, the failure prints on stderr naming what it was,
 * and the error that reaches `main().catch` is always the real one.
 *
 * Invoked by .github/workflows/e2e.yml — moved there from stack.yml in S4.3
 * (D298/D306: this guard's failure source is app code ordinary web PRs touch,
 * and `stack` no longer gates a merge, so it runs on the PR critical path).
 * Standalone, from the repo root against a running compose stack:
 *   BETTER_AUTH_SECRET=ddl-drift-check-dummy-secret-not-a-real-one \
 *     npx tsx --tsconfig apps/web/tsconfig.json --conditions react-server \
 *     deploy/compose/ddl-drift-check.mts
 * (the secret is required by `authConfig()` and plays no part in the schema;
 * BETTER_AUTH_URL is deliberately NOT set anywhere — D119.)
 */
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client, type Pool } from "pg";
import { getMigrations } from "better-auth/db/migration";
import { authConfig } from "@/server/auth";
import { getPool } from "@/server/postgres";

/** Compose's Postgres (D112(b)); an exported OBSTACK_POSTGRES_DSN still wins. */
const DEFAULT_DSN = "postgres://obstack:obstack_postgres_dev@127.0.0.1:5432/obstack";

const CAPTURED = "services/ingest/pgmigrations/0003_auth.sql";
const CAPTURED_URL = new URL(`../../${CAPTURED}`, import.meta.url);
const CONFIG = "apps/web/src/server/auth.ts";

/**
 * The listener whose absence crashed the guard (see the header). A pg Pool or
 * Client emitting `'error'` with nothing listening is an unhandled event, and
 * Node throws it out of the event loop past every `catch` in this file. There
 * is nothing to report here — a connection dying during teardown is the point
 * of the teardown — so the handler exists purely to make the event handled.
 */
const ignoreTeardownError = (): void => undefined;

/**
 * One teardown step, which may fail and may not take the run down with it.
 *
 * `finally` runs while the capture's own error is in flight, and a rejection
 * raised inside it REPLACES that error: the run would report "Connection
 * terminated unexpectedly" — a symptom of the cleanup — where it should have
 * reported the DDL drift, or the auth-config failure, that is the only thing
 * anybody wants from this script. That is exactly the teardown-race territory
 * this file already fixed once at the pool: `server.on('error')` above makes a
 * dying socket a handled EVENT, but it does nothing for a `query()` PROMISE
 * that rejects because the connection is gone, which is what an admin
 * connection killed alongside the pools produces. So every step is wrapped, no
 * step can skip the steps after it, and the failure is printed rather than
 * swallowed — an orphaned scratch database on the compose Postgres should be
 * visible in the log that caused it.
 */
async function bestEffort(what: string, step: () => Promise<unknown>): Promise<void> {
  try {
    await step();
  } catch (err: unknown) {
    console.error(`ddl-drift: teardown: ${what}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function fail(message: string): never {
  console.error(`ddl-drift: ${message}`);
  process.exit(1);
}

/** The file minus its comment header — the SQL the ingest binary applies. */
function body(captured: string): string {
  return captured
    .split("\n")
    .filter((line) => !line.startsWith("--"))
    .join("\n")
    .trim();
}

/** The re-capture recipe, read from the one place it is written down. */
function recipe(captured: string): string[] {
  return captured
    .split("\n")
    .filter((line) => line.startsWith("--   "))
    .map((line) => line.slice(3));
}

/** Both the capture and the file are blank-line-separated statements. */
function statements(sql: string): string[] {
  return sql
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function driftReport(generated: string, captured: string): string[] {
  const fresh = statements(generated);
  const onDisk = statements(captured);
  const added = fresh.filter((s) => !onDisk.includes(s));
  const gone = onDisk.filter((s) => !fresh.includes(s));

  const out: string[] = [];
  if (added.length > 0) {
    out.push(`generated from ${CONFIG}'s authConfig(), missing from ${CAPTURED}:`);
    for (const s of added) out.push(`  ${s}`);
  }
  if (gone.length > 0) {
    out.push(`in ${CAPTURED}, no longer generated from ${CONFIG}'s authConfig():`);
    for (const s of gone) out.push(`  ${s}`);
  }
  if (added.length === 0 && gone.length === 0) {
    out.push(
      `same ${fresh.length} statement(s) on both sides, in a different order or spacing —` +
        " the capture is verbatim output, so the file must match it exactly",
    );
  }
  return out;
}

async function main(): Promise<void> {
  const admin = process.env.OBSTACK_POSTGRES_DSN ?? DEFAULT_DSN;
  // A database name cannot be bound as a parameter, so it is generated here as
  // hex and never comes from input (D11's rule survives intact).
  const scratch = `obstack_ddl_drift_${randomBytes(6).toString("hex")}`;

  const server = new Client({ connectionString: admin, application_name: "obstack-ddl-drift-check" });
  server.on("error", ignoreTeardownError);
  await server.connect();
  console.log(`ddl-drift: capturing into scratch database ${scratch} on ${new URL(admin).host}`);
  await server.query(`CREATE DATABASE "${scratch}"`);

  let generated: string;
  const pools: Pool[] = [];
  try {
    // authConfig() reads the DSN when it opens the pool, so the scratch
    // database is named before the config is built — and the empty database it
    // points at is what makes the generator emit the whole schema.
    const scratchDsn = new URL(admin);
    scratchDsn.pathname = `/${scratch}`;
    process.env.OBSTACK_POSTGRES_DSN = scratchDsn.href;

    // Every pool the capture can run on, each carrying the listener before a
    // single client exists on it.
    //
    // Two, not one, and that is the whole subtlety: `authConfig()` reaches
    // `@/server/postgres` through its own module graph, and under
    // `--conditions react-server` that resolves to a DIFFERENT instance of the
    // module than this script's own `getPool()` import — two lazy `let pool`
    // singletons, provably distinct objects (`authConfig().database !==
    // getPool()`, measured). The pool the capture actually uses is therefore
    // the one hanging off the config — better-auth hands it straight to
    // kysely's PostgresDialect — and it is the one that used to crash, which is
    // why attaching to `getPool()` alone did NOT fix this. Registering both
    // makes the question of whether they coincide irrelevant.
    const config = authConfig();
    for (const candidate of new Set<Pool>([getPool(), config.database])) {
      candidate.on("error", ignoreTeardownError);
      pools.push(candidate);
    }

    const plan = await getMigrations(config);
    generated = (await plan.compileMigrations()).trim();
  } finally {
    // Teardown in the one order that cannot race (the header argues it), and
    // every step BEST-EFFORT (see `bestEffort`): the capture's error is the one
    // that must reach the operator, and each step must still get its turn when
    // the step before it failed — a skipped DROP is a scratch database orphaned
    // on the compose Postgres, and a skipped `server.end()` is a hung process.
    //   1. ask every pool to close. `end()` resolves early — its sockets may
    //      still be draining — and a capture that threw may never have reached
    //      the loop above, so this neither waits for quiet nor is allowed to
    //      mask the throw;
    await Promise.all(
      pools.map((p, i) => bestEffort(`closing pool ${i + 1} of ${pools.length}`, () => p.end())),
    );
    //   2. terminate anything still attached to the scratch database, and WAIT
    //      for Postgres to answer. This is the step FORCE used to do implicitly
    //      and at the worst possible moment;
    await bestEffort(`terminating backends on ${scratch}`, () =>
      server.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [scratch],
      ),
    );
    //   3. drop plainly. DROP DATABASE already waits out backends that are
    //      exiting (5s in CountOtherDBBackends), and step 2 left it nothing
    //      else, so FORCE would have nothing to add. If this is what failed,
    //      the message names the database a human now has to drop.
    await bestEffort(`dropping ${scratch} — drop it by hand if it is still there`, () =>
      server.query(`DROP DATABASE IF EXISTS "${scratch}"`),
    );
    await bestEffort("closing the admin connection", () => server.end());
  }

  const captured = await readFile(CAPTURED_URL, "utf8");
  if (generated !== body(captured)) {
    for (const line of driftReport(generated, body(captured))) console.error(`ddl-drift:   ${line}`);
    console.error(`ddl-drift:   ${CAPTURED} is generated FROM ${CONFIG} — re-capture it with the`);
    console.error("ddl-drift:   recipe in its own header and commit the result:");
    for (const line of recipe(captured)) console.error(`ddl-drift:     ${line}`);
    fail(`${CONFIG}'s authConfig() no longer generates ${CAPTURED}`);
  }

  console.log(
    `ddl-drift:   ${statements(generated).length} statement(s) regenerated from authConfig(), identical to ${CAPTURED}`,
  );
  console.log("ddl-drift: PASS");
}

main().catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
