import "server-only";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Spelled out here rather than imported from `@/server/data`, which exports
 * the same union: this module is the FIRST thing the process runs, and
 * importing `data.ts` would evaluate its module-level `resolveMode()` before
 * the boot check gets to speak — a live artifact missing CLICKHOUSE_URL would
 * throw out of the dynamic import in `register()`, outside the try/catch
 * below, and go back to answering 500s instead of exiting. Two spellings of
 * two string literals is the cheaper side of that trade.
 */
export type DataMode = "live" | "mock";

/**
 * D267: the stamp is a plain file baked into the image at build time
 * (apps/web/Dockerfile), read back here at boot — this is the one place its
 * path is stated. `server.js` (the standalone output's own entry point)
 * calls `process.chdir(__dirname)` before anything else runs, so
 * `process.cwd()` at boot is the same monorepo-relative directory
 * (`apps/web/`) the Dockerfile writes the stamp into, whether that directory
 * happens to be `/app/apps/web` in the image or `apps/web/.next/standalone/
 * apps/web` on a host running the standalone output directly.
 */
export const STAMP_PATH = path.join(process.cwd(), ".obstack-mode-stamp");

/**
 * `undefined` is the checkout case — dev, the e2e drive, local `next start`
 * — none of which ever bake a stamp file, so none of them are touched by
 * anything below (D267: stamp file absent → no-op).
 */
export function readModeStamp(stampPath: string = STAMP_PATH): DataMode | undefined {
  let raw: string;
  try {
    raw = readFileSync(stampPath, "utf8").trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  if (raw !== "live" && raw !== "mock") {
    throw new Error(
      `corrupt mode stamp at ${stampPath}: got ${JSON.stringify(raw)}, want "live" or "mock"`,
    );
  }
  return raw;
}

/**
 * D251(b)/D265(a2)/D267/D353 — the five boot outcomes, in order:
 *  1. stamp absent                        → no-op, returns
 *  2. stamp present, runtime mode unset   → refuse (explicit over implicit
 *     at "costs signup entirely" stakes — compose and the chart always set
 *     `OBSTACK_DATA_MODE`, so an unset runtime here means something upstream
 *     forgot to)
 *  3. stamp and runtime mode disagree     → refuse, naming both values
 *  4. live-stamped, no signing secret     → refuse, with the generate
 *     instruction (mock-stamped artifacts need no secret: no auth, no
 *     Postgres, D262)
 *  5. mock-stamped, a real billing rail    → refuse, naming both values
 *     (D353)
 *
 * (5) is here and not in `billing/` for the reason that makes it necessary at
 * all: a mock artifact never reaches `getBilling()`, so a refusal inside the
 * billing module would guard a path this artifact does not run — it would boot
 * and serve a demo advertising a rail no request can reach. It is a comparison
 * of two environment variables and stays one: this module imports nothing from
 * `billing/`, which is the same D110 boundary the billing barrel keeps from the
 * other side. The INVERSE is deliberately not refused — live + `fake` is what
 * compose, the chart and every self-hosted deployment that never bills run.
 *
 * Every refusal is a thrown `Error` — pure and unit-testable. What actually
 * stops the process on that throw is `checkModeStampOnBoot` below, the one
 * caller (from instrumentation.ts's `register()`, which Next.js must finish
 * before the server accepts its first request per node_modules/next/dist/
 * docs/01-app/03-api-reference/03-file-conventions/instrumentation.md).
 */
export function assertModeStamp(
  stamp: DataMode | undefined,
  // A plain string dict rather than `NodeJS.ProcessEnv` on purpose: Next.js's
  // own type augmentation (node_modules/next/types/global.d.ts) makes
  // `NODE_ENV` a required key on that interface, which every test env
  // literal below would otherwise have to carry for no reason relevant to
  // this check. `process.env` satisfies this shape structurally.
  env: Record<string, string | undefined> = process.env,
): void {
  if (stamp === undefined) return;

  const runtime = env.OBSTACK_DATA_MODE;
  if (!runtime) {
    throw new Error(
      `refusing to start: this artifact was built with OBSTACK_DATA_MODE=${stamp} baked in, but the ` +
        `runtime environment leaves OBSTACK_DATA_MODE unset. Set OBSTACK_DATA_MODE=${stamp} explicitly.`,
    );
  }
  if (runtime !== stamp) {
    throw new Error(
      `refusing to start: this artifact was built with OBSTACK_DATA_MODE=${stamp} baked in, but is ` +
        `running with OBSTACK_DATA_MODE=${runtime}. A mismatched serve is refused, not rendered.`,
    );
  }

  // Unset IS `fake`: that is `billingMode()`'s default (D168), so an absent
  // variable is the demo's own configuration rather than something forgotten.
  const billing = env.OBSTACK_BILLING_MODE;
  if (stamp === "mock" && billing && billing !== "fake") {
    throw new Error(
      `refusing to start: this artifact was built with OBSTACK_DATA_MODE=mock baked in, but is ` +
        `running with OBSTACK_BILLING_MODE=${billing}. A mock artifact serves generated data and ` +
        `never reaches the billing rail; set OBSTACK_BILLING_MODE=fake or leave it unset.`,
    );
  }

  if (stamp === "live" && !env.BETTER_AUTH_SECRET) {
    throw new Error(
      "refusing to start: a live-stamped artifact requires BETTER_AUTH_SECRET (it signs " +
        "session cookies), which is unset or empty. Generate one with: openssl rand -base64 32",
    );
  }
}

/**
 * The one call site: instrumentation.ts's `register()`.
 *
 * A thrown `Error` alone does not "refuse to start" against this Next
 * version's actual production runtime — verified against a running
 * container, not assumed from the docs. `next-server.js` fires `prepare()`
 * once, fire-and-forget, specifically so a rejection there does not become
 * an unhandled promise rejection:
 *
 *   this.prepare().catch((err) => console.error('Failed to prepare server', err))
 *
 * The rejection is deferred to be re-awaited on the first real request
 * instead, so an artifact whose `register()` throws does not exit — it
 * comes up, listens, and answers every request with a 500, forever. That is
 * "renders broken," not "refuses to start" (D251(b)). Catching here and
 * exiting is what makes the refusal actually stop the process — proven by
 * `docker run` against both a mismatched and an unconfigured artifact
 * (T1's done-check), not by a unit test: `process.exit` inside a test
 * would kill the test runner itself, not just the assertion.
 */
export function checkModeStampOnBoot(): void {
  try {
    assertModeStamp(readModeStamp());
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
