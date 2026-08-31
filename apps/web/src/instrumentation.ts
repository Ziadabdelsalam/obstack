/**
 * Next's server-startup hook (`register`, called once per server instance,
 * before the first request) — this app's one place for work that belongs to the
 * PROCESS rather than to a request.
 *
 * Two things run here now:
 *
 * 1. The mode-stamp boot check (D251(b)/D265(a2)/D267): a mismatched or
 *    under-configured artifact must refuse to start before it ever answers a
 *    request. `checkModeStampOnBoot` does both the checking AND the actual
 *    process exit on refusal — see `@/server/mode-stamp` for the five
 *    outcomes and why exiting there, not just throwing, is what "refuse
 *    loudly" requires against this Next version's runtime.
 * 2. The periodic usage report to Polar (D170). Everything about whether it
 *    should actually run lives in `startUsageReporter` — mock mode and
 *    `fake` billing start nothing, which is why CI, local dev and a
 *    mock-mode deployment all execute this file and none of them meter.
 *
 * Both imports are dynamic and inside the guard for the reason the Next guide
 * gives: `register` is called in every runtime, and both the boot check (it
 * reads a file) and the reporter (it opens a Postgres pool) are Node-only.
 * `NEXT_RUNTIME` is how a runtime names itself.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { checkModeStampOnBoot } = await import("@/server/mode-stamp");
  checkModeStampOnBoot();

  // Through the barrel like every other caller (D184): the module boundary that
  // owns every Polar call owns this entry too, so there is exactly one import
  // path into it and nothing here learns what a Polar object is.
  const { startUsageReporter } = await import("@/server/billing");
  startUsageReporter();
}
