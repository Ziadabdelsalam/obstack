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
import { Client } from "pg";
import { getMigrations } from "better-auth/db/migration";
import { authConfig } from "@/server/auth";
import { getPool } from "@/server/postgres";

/** Compose's Postgres (D112(b)); an exported OBSTACK_POSTGRES_DSN still wins. */
const DEFAULT_DSN = "postgres://obstack:obstack_postgres_dev@127.0.0.1:5432/obstack";

const CAPTURED = "services/ingest/pgmigrations/0003_auth.sql";
const CAPTURED_URL = new URL(`../../${CAPTURED}`, import.meta.url);
const CONFIG = "apps/web/src/server/auth.ts";

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
  await server.connect();
  console.log(`ddl-drift: capturing into scratch database ${scratch} on ${new URL(admin).host}`);
  await server.query(`CREATE DATABASE "${scratch}"`);

  let generated: string;
  try {
    // authConfig() reads the DSN when it opens the pool, so the scratch
    // database is named before the config is built — and the empty database it
    // points at is what makes the generator emit the whole schema.
    const scratchDsn = new URL(admin);
    scratchDsn.pathname = `/${scratch}`;
    process.env.OBSTACK_POSTGRES_DSN = scratchDsn.href;

    const plan = await getMigrations(authConfig());
    generated = (await plan.compileMigrations()).trim();
    await getPool().end();
  } finally {
    // FORCE because a capture that threw leaves better-auth's pool connected.
    await server.query(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`);
    await server.end();
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
