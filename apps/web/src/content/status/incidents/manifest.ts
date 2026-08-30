import type { ComponentType } from "react";

/**
 * THE incident manifest (D320/D324) — the source of truth for which incident
 * notices `/status` publishes.
 *
 * IT SHIPS EMPTY, AND THAT IS THE LAUNCH STATE. obstack has recorded no
 * incidents, so the page says "No incidents recorded." rather than showing a
 * placeholder one. Nothing generates an entry here: a notice is written by a
 * person, after something happened, and lands as a file plus one line in this
 * array (D256 — "manually curated", no bespoke backend).
 *
 * Why a hand-written list rather than a filesystem walk: the same reason the
 * docs have one (`src/content/docs/manifest.ts`) — no module that ships may
 * read the filesystem (D320). This array compiles into the bundle;
 * `src/lib/docs/incidents.test.ts` walks the directory with `fs` at TEST time
 * and fails if the two disagree in either direction (D206 mirror shape).
 *
 * WHY EACH ENTRY CARRIES ITS OWN `import()` RATHER THAN A COMPUTED PATH.
 * MEASURED on next 16.3.0, Turbopack: the docs loader's form —
 * ``await import(`@/content/docs/${contentPath}.mdx`)`` — makes a context
 * module by globbing the directory, and a directory holding NO `.mdx` file at
 * all fails the build outright:
 *
 *   Module not found: Can't resolve '@/content/status/incidents/' <dynamic> '.mdx'
 *
 * The docs never hit this because their corpus is never empty; an incident
 * directory is empty exactly when the product is behaving, which is the state
 * this page must render best. Shipping a fixture notice to keep the glob happy
 * would publish an invented incident — the fiction D256 deleted. So the
 * specifier moves here, where it is a LITERAL per entry: an empty array has no
 * import in it, nothing to resolve, and the build is green with the directory
 * genuinely empty. It also drops the whole class of context-module traps T1
 * measured (nested templates, silent prerender loss) — the slug is known here,
 * so nothing has to be computed.
 *
 * PUBLISHING A NOTICE (the whole procedure):
 *   1. create `src/content/status/incidents/YYYY-MM-DD-slug.mdx` — see
 *      `README.md` beside this file for the frontmatter contract;
 *   2. add one entry here, with its `file` and an `import()` of that same file.
 * Doing either half alone turns `incidents.test.ts` red, which is the point —
 * and so does an entry whose `import()` names a different file than its `file`.
 *
 * ORDER ON THE PAGE IS BY DATE, NEWEST FIRST — this array's order only breaks
 * a tie between two notices carrying the same date.
 */

/** What an `.mdx` notice compiles to: its body, and the frontmatter it declares. */
export interface IncidentModule {
  readonly default: ComponentType;
  readonly frontmatter?: unknown;
}

/** A published notice. `file` is the name under this directory, without `.mdx`. */
export interface IncidentManifestEntry {
  /** `"2026-09-14-ingest-backlog"` → `2026-09-14-ingest-backlog.mdx`, beside this file. */
  readonly file: string;
  /** That same file, imported. Lazy: the pure test never calls it, so it needs no MDX loader. */
  readonly load: () => Promise<IncidentModule>;
}

export const incidentsManifest: readonly IncidentManifestEntry[] = [
  // Each published notice is one line, and it looks like this:
  //
  //   { file: "2026-09-14-ingest-backlog", load: () => import("./2026-09-14-ingest-backlog.mdx") },
  //
  // (the example above is a comment, not an entry — there is no such file, and
  // the page has nothing to list).
];
