/**
 * Next's server-startup hook (`register`, called once per server instance,
 * before the first request) — this app's one place for work that belongs to the
 * PROCESS rather than to a request.
 *
 * Today that is exactly one thing: the periodic usage report to Polar (D170).
 * Everything about whether it should actually run lives in `startUsageReporter`
 * — mock mode and `fake` billing start nothing, which is why CI, local dev and
 * a mock-mode deployment all execute this file and none of them meter.
 *
 * The import is dynamic and inside the guard for the reason the Next guide
 * gives: `register` is called in every runtime, and the reporter is Node-only
 * (it opens a Postgres pool). `NEXT_RUNTIME` is how a runtime names itself.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Through the barrel like every other caller (D184): the module boundary that
  // owns every Polar call owns this entry too, so there is exactly one import
  // path into it and nothing here learns what a Polar object is.
  const { startUsageReporter } = await import("@/server/billing");
  startUsageReporter();
}
