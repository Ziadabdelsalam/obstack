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
 * A rate per minute, in display form — the ONE formatter for it (D409), shared
 * by the service catalog, the service detail and the live map.
 *
 * Precision follows the magnitude, because a per-minute rate over a 24h window
 * gets very small: four spans all day really is 0.003/min, and one decimal
 * would print that as "0.0" — a service that sent spans, rendered as silent.
 * There is no `<0.01` floor either: we hold the number, so we print it (D13).
 *
 * The unit belongs to the CALL SITE — a table whose column header already says
 * "spans/min" would otherwise repeat it in every cell.
 */
export function fmtPerMin(n: number): string {
  if (n === 0) return "0";
  if (n >= 10) return Math.round(n).toLocaleString("en-US");
  if (n >= 0.1) return n.toFixed(1);
  return n.toFixed(3);
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

/**
 * Bytes in the unit a reader of a container limit thinks in (D468): the same
 * binary units Kubernetes accepts on the manifest, so a "128 MiB memory limit"
 * on the infra page is the `128Mi` someone wrote.
 *
 * The unit steps rather than the number: a working set of 41 943 040 reads as
 * "40 MiB", not as "0.0 GiB". One decimal starts at GiB, where the whole-number
 * form would round a 1.7 GiB node down to the same "2 GiB" as a 2.4 GiB one.
 */
export function fmtBytes(n: number): string {
  if (n < 1024 ** 2) return `${Math.round(n / 1024)} KiB`;
  if (n < 1024 ** 3) return `${Math.round(n / 1024 ** 2)} MiB`;
  return `${(n / 1024 ** 3).toFixed(1)} GiB`;
}

/**
 * CPU in the unit the value was written in (D468): under a core, the millicores
 * of a `cpu: 550m` request; at or above one, the cores of `cpu: "2"`. Decimals
 * are trimmed rather than padded, so a 2-core limit is "2" and not "2.00".
 *
 * The unit belongs to the CALL SITE for cores exactly as it does for
 * `fmtPerMin` — "0.55 CPU limit" would be the sentence's job to spell, and
 * "550m" carries its own.
 */
export function fmtCores(n: number): string {
  if (n < 1) return `${Math.round(n * 1000)}m`;
  return String(Number(n.toFixed(2)));
}
