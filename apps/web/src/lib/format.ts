export function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
}

export function fmtTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function fmtCost(usd: number): string {
  if (usd === 0) return "—";
  if (usd >= 0.01) return `$${usd.toFixed(2)}`;
  if (usd >= 0.0001) return `$${usd.toFixed(4)}`;
  // A real ingested trace can cost a few hundred-thousandths of a dollar, and
  // four decimals would print that as $0.0000 — a charge shown as free. Below
  // what 4dp can express, keep two significant digits instead of rounding a
  // real cost away to nothing.
  // capped at toFixed's own maximum, not at a display width — a cap of 10 would
  // print anything under $0.0000000001 as "$0.", the very lie this branch exists
  // to prevent.
  const decimals = Math.min(100, 1 - Math.floor(Math.log10(usd)));
  return `$${usd.toFixed(decimals).replace(/0+$/, "")}`;
}

/**
 * An age against an explicit reference clock (D50/D64) — the request's server
 * time in live mode, the mock clock in mock mode — sampled once per request by
 * the page and threaded down, exactly as `/app/logs` ages its rows.
 *
 * `nowMs` is REQUIRED, and a default is what this signature exists to refuse:
 * this file used to age every row against the mock clock, which sits in the
 * past of any ingested row, so every live trace rendered "just now" (measured,
 * D64). A `Date.now()` default would be the same lie inverted — every mock row
 * aged against the wall clock. Neither clock is right for both modes, so the
 * caller that knows the mode names it.
 */
export function timeAgo(iso: string, nowMs: number): string {
  const diff = nowMs - Date.parse(iso);
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ago`;
}

export function fmtClock(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}:${String(d.getUTCSeconds()).padStart(2, "0")}`;
}
