/**
 * Phase 1 acceptance assertion (D16/D17).
 *
 * Drives the real web facade — `apps/web/src/server/data.ts`, the same module the app
 * renders from — against the trace the demo agent just emitted. No Next server,
 * no throwaway API route: `--conditions react-server` satisfies the `server-only`
 * guard and tsx resolves the `@/` paths from the app's tsconfig.
 *
 * The checks themselves live in `trace-checks.ts`, shared with the kind/Helm
 * acceptance harness (`deploy/helm/obstack/acceptance.ts`) so the two paths
 * assert one definition of "the trace landed whole" (S2.2 T5). What this file
 * keeps is M1's signed exit behavior: same env defaults, same output, same
 * exit codes.
 *
 * Normally invoked by `smoke.sh`; standalone, from the repo root:
 *   npx tsx --tsconfig apps/web/tsconfig.json --conditions react-server \
 *     deploy/compose/smoke.ts <trace_id>
 */
import type { Trace } from "@/lib/types";
import {
  ARRIVAL_TIMEOUT_MS,
  awaitWholeTrace,
  DEMO_WORKSPACE,
  REQUIRED_LAYERS,
  TraceIncompleteError,
} from "./trace-checks";

function fail(message: string): never {
  console.error(`smoke: ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const traceId = process.argv[2];
  if (!traceId) fail("usage: smoke.ts <trace_id>");

  // The facade resolves its mode at import time (D13), so the env comes first.
  // The workspace is NOT among them: it is an argument now (D96/D113), and the
  // stack this asserts against writes under the one `DEMO_WORKSPACE` names.
  process.env.OBSTACK_DATA_MODE = "live";
  process.env.CLICKHOUSE_URL ??= "http://127.0.0.1:8123";
  process.env.CLICKHOUSE_USER ??= "obstack_web";
  process.env.CLICKHOUSE_PASSWORD ??= "obstack_web_dev";

  let whole: Trace;
  try {
    whole = await awaitWholeTrace(DEMO_WORKSPACE, traceId, ARRIVAL_TIMEOUT_MS);
  } catch (err) {
    if (err instanceof TraceIncompleteError) {
      for (const p of err.problems) console.error(`smoke:   - ${p}`);
    }
    throw err;
  }

  const byLayer = REQUIRED_LAYERS.map(
    (l) => `${l}=${whole.spans.filter((s) => s.layer === l).length}`,
  ).join(" ");
  const llm = whole.spans.find((s) => s.layer === "llm")?.llm;
  console.log(`smoke: trace ${traceId} lists and resolves through the facade`);
  console.log(`smoke:   ${whole.service} · ${whole.rootName} · ${whole.durationMs}ms · ${whole.spans.length} spans (${byLayer})`);
  console.log(
    `smoke:   llm ${llm?.model} · ${llm?.inputTokens}+${llm?.outputTokens} tokens · $${whole.costUsd.toFixed(6)}`,
  );
  console.log(`smoke:   ${whole.logs.filter((l) => l.traceId === traceId).length} correlated log(s)`);
  console.log("smoke: PASS");
}

main().catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
