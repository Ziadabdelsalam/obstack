import "server-only";

/**
 * THE one place `/status`'s external-monitor link is read (D342, T5).
 *
 * D256 shipped `/status` saying "external uptime monitoring begins at
 * launch" — true then, false the day a monitor exists, and untestable in
 * between because nothing measured it. K9/D342 name the monitor (Better
 * Stack, the user's account) and rule the shape: `/status` may LINK to its
 * public status page and nothing else — no third-party script, image or
 * iframe embedded in obstack's own page. So the only input this deployment
 * needs is one URL, and — exactly the D329 shape `lib/app-href.ts` set for
 * `OBSTACK_APP_ORIGIN` — `/status` is prerendered (`page.tsx`'s own header
 * comment), so the value is read once while `next build` renders the page
 * and BAKED into the static HTML. There is no runtime override and no
 * per-request read, which is why this is a build ARG/ENV in
 * `apps/web/Dockerfile` beside `OBSTACK_APP_ORIGIN`, not a runtime secret.
 *
 * Unset — the default, and every deployment until the monitor's URL exists —
 * yields `null`, and the page says plainly that it publishes no external
 * monitor. That is not a placeholder for a value nobody supplied yet; it is
 * the honest state of a deployment that runs no monitor, same as `/status`'s
 * component rows carry no state because nothing measures one (D256).
 *
 * WHY THE VALUE IS VALIDATED HERE. `/status` is prerendered, so a malformed
 * value is not a runtime error a request could surface — it is baked into
 * static HTML served to strangers forever. Refused rather than degraded:
 * anything other than an absolute `https:` URL (`http:`, a bare host, a
 * scheme this deployment did not mean) throws at build time naming the
 * variable, so `next build` fails loudly instead of shipping a broken or
 * insecure link to obstack's own uptime monitor. `https:` only — not
 * `http(s):` the way `app-href.ts` allows both — because a status page is
 * exactly the surface a stranger checks when something else is down, and it
 * is never legitimately served over plain HTTP.
 */
export function statusMonitorUrl(): string | null {
  const configured = process.env.OBSTACK_STATUS_MONITOR_URL?.trim() ?? "";
  if (configured === "") return null;
  return monitorOrigin(configured);
}

/** The configured value, proven an absolute https URL and stripped of trailing slashes. */
function monitorOrigin(configured: string): string {
  const refuse = (why: string): never => {
    throw new Error(
      `OBSTACK_STATUS_MONITOR_URL=${JSON.stringify(configured)} ${why}. It must be an absolute ` +
        'https URL, e.g. "https://obstack.betteruptime.com" — D342 permits /status to link the ' +
        "external monitor and nothing else, and the value is baked into the prerendered page at " +
        "build time, so a wrong one ships to every reader until the next build.",
    );
  };

  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    // The scheme-less case lands here: `new URL("status.example.com")` throws.
    return refuse("is not a URL with a scheme");
  }
  if (parsed.protocol !== "https:") {
    return refuse(`has scheme "${parsed.protocol}", not "https:"`);
  }
  return configured.replace(/\/+$/, "");
}
