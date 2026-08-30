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
 * sprint after the hero grew its own). The auth pages' own prose stays
 * same-host because it is about THIS deployment ("there is nothing here to sign
 * in to"), and it is the sentence that turns false the day S5 gives obstack a
 * hosted home — which is an S5-GATE item, not something a helper can paper over.
 */
export function appHref(path: string): string {
  return `${process.env.OBSTACK_APP_ORIGIN ?? ""}${path}`;
}
