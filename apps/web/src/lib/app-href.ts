import "server-only";

/**
 * THE one place a link that must reach the RUNNING app is written (D329/K13).
 *
 * D262 makes the marketing site and the application two deployments of one
 * image: the public host runs `OBSTACK_DATA_MODE=mock` and has no accounts, no
 * Postgres and nothing to sign into. Its "Create your workspace" button
 * therefore pointed at its own `/signup`, which renders an honest page saying
 * there is no workspace to create here — a stranger's first click landing on a
 * dead end that is not even a bug on that host. The live app is a different
 * origin, and only S5 knows which.
 *
 * So the origin is one build-time input with an honest name. `/` is prerendered
 * (`○ Static`), which means every call below runs while `next build` renders the
 * page and the result is BAKED INTO THE HTML — there is no runtime override and
 * no per-request read, exactly like `OBSTACK_DATA_MODE` beside it in
 * `apps/web/Dockerfile` (D251(b)). Naming it `NEXT_PUBLIC_*` would have implied
 * a client read that never happens, so it is not one, and `server-only` makes
 * the compiler enforce that: a client component importing this file fails the
 * build rather than shipping an environment read to a browser.
 *
 * Unset — the default, and every deployment before S5 — yields the path
 * unchanged, so a single-host obstack links to itself exactly as it always did.
 *
 * Scope is the three "Create your workspace" buttons, deliberately (D329) —
 * the nav's, the hero's and the closing CTA's; `app-href.test.ts` counts them
 * against the page so this sentence cannot drift again (it said "two" for a
 * sprint after the hero grew its own). The auth pages' own LINKS stay same-host
 * because their prose is about THIS deployment ("there is nothing here to sign
 * in to"). The half of that prose which turned false the day obstack got a
 * hosted home — the S5-GATE item this docblock used to defer — is now taken,
 * by `appHost()` below rather than by this function (D340).
 *
 * WHY THE VALUE IS VALIDATED HERE AND NOWHERE ELSE. Because `/` is prerendered,
 * a wrong value is not a runtime error a request could surface — it is baked
 * into static HTML at build time and then served to strangers forever. The two
 * ways to get it wrong are both quiet: a trailing slash yields
 * `https://app.obstack.dev//signup` (a protocol-relative-looking double slash
 * that some proxies rewrite and every reader mistrusts), and a scheme-less
 * `app.obstack.dev` yields `app.obstack.dev/signup` — a RELATIVE href, so the
 * three buttons below would resolve against the marketing host and land back on
 * the dead-end `/signup` this helper exists to route around. Neither is visible
 * in a diff or in a rendered smoke check; both are trivially visible to
 * `new URL()`. So the build refuses: a malformed origin throws while the page
 * renders, `next build` fails naming the variable, and no deployment can ship
 * the broken link. Unset still means unset — the refusal is about a value that
 * was configured and is wrong, never about the single-host default.
 */
export function appHref(path: string): string {
  const configured = process.env.OBSTACK_APP_ORIGIN?.trim() ?? "";
  if (configured === "") return path;
  return `${appOrigin(configured)}${path}`;
}

/**
 * The host half of the same value, for prose rather than a link (D340).
 *
 * The moment the configured host exists, every sentence on this build saying
 * obstack is not hosted becomes false (D13 outranks the S4.4 landing-is-spec
 * ruling — it freezes target claims, never keeps a false one). Five sentences
 * across `page.tsx`, the auth pages and the invite page name what obstack a
 * signup lands on, and they read this instead of `OBSTACK_APP_ORIGIN`
 * directly so the value they render is a bare host, never a scheme or a path
 * — U11 forbids a literal host name in source, and this is the one place
 * that reads the env so those five sites never do.
 *
 * Reuses `appOrigin`'s validation rather than re-parsing: a malformed value
 * fails the same way `appHref` fails it, at `next build`, for the same reason
 * (D329) — this is also baked into prerendered HTML.
 */
export function appHost(): string | null {
  const configured = process.env.OBSTACK_APP_ORIGIN?.trim() ?? "";
  if (configured === "") return null;
  return new URL(appOrigin(configured)).host;
}

/** The configured value, proven absolute-http(s) and stripped of trailing slashes. */
function appOrigin(configured: string): string {
  const refuse = (why: string): never => {
    throw new Error(
      `OBSTACK_APP_ORIGIN=${JSON.stringify(configured)} ${why}. It must be an absolute ` +
        'http(s) origin, e.g. "https://app.obstack.dev" — it is prefixed to app paths at ' +
        "build time and baked into the prerendered marketing page (D329).",
    );
  };

  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    // The scheme-less case lands here: `new URL("app.obstack.dev")` throws.
    return refuse("is not a URL with a scheme");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return refuse(`has scheme "${parsed.protocol}"`);
  }
  // A query or fragment cannot survive concatenation — `…?x=1` + `/signup`
  // makes the path part of the query — so it is refused rather than mangled.
  if (parsed.search !== "" || parsed.hash !== "") {
    return refuse("carries a query string or fragment");
  }
  return configured.replace(/\/+$/, "");
}
