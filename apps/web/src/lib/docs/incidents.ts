import {
  incidentsManifest,
  type IncidentManifestEntry,
} from "@/content/status/incidents/manifest";

/**
 * The status page's content model, resolved (D256/D324) — the PURE half of the
 * incidents loader: the component ids, the frontmatter contract, and the
 * newest-first ordering. No `fs`, no `next/*`, no MDX import, so
 * `incidents.test.ts` can import it directly under the suite's
 * `tsx --conditions react-server` runner, which has neither a filesystem
 * fixture nor an MDX loader. The two-module split is the docs loader's
 * (`./docs.ts` + `./load.ts`), for the same reason.
 *
 * The half that actually pulls a notice in — the dynamic `import()` — is
 * `./incidents-load.ts`, because it only means anything inside a module Next
 * compiles.
 *
 * MODE-BLIND, like the docs: `/status` is public and is built once for both
 * images (D251/D267), so nothing here imports the demo corpus or asks what
 * mode it is in.
 */

export type { IncidentManifestEntry };

/**
 * THE component ids, defined once.
 *
 * They are ids, not scores. `/status` names each of these and says what it is;
 * it does not say whether it is up, because obstack runs no monitor that could
 * answer (D256) — a state pill beside a name with nothing feeding it is a
 * claim, not a status. An incident notice's `components` field is a list drawn
 * from this array, and `incidents.test.ts` fails on anything else, so a notice
 * cannot name a component the page does not list.
 */
export const STATUS_COMPONENT_IDS = ["app", "ingest", "docs"] as const;
export type StatusComponentId = (typeof STATUS_COMPONENT_IDS)[number];

/**
 * A notice's own state, as last written by its author. Nothing advances it:
 * there is no monitor to resolve an incident and no job to age one out, so
 * `investigating` means somebody wrote `investigating` and has not been back.
 */
export const INCIDENT_STATUSES = ["investigating", "monitoring", "resolved"] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

/** The frontmatter every notice exports. See `src/content/status/incidents/README.md`. */
export interface IncidentFrontmatter {
  /** `YYYY-MM-DD`, equal to the file name's prefix. Orders the page. */
  readonly date: string;
  readonly title: string;
  readonly status: IncidentStatus;
  /** Non-empty, drawn from `STATUS_COMPONENT_IDS`. */
  readonly components: readonly StatusComponentId[];
}

/** A published notice: which file it is, and what it declares about itself. */
export interface IncidentNotice {
  /** The manifest's `file` — the name under `src/content/status/incidents/`, no extension. */
  readonly file: string;
  readonly frontmatter: IncidentFrontmatter;
}

/** `2026-09-14-ingest-backlog` — the date first, so the name sorts the way the page does. */
export const INCIDENT_FILE_PATTERN = /^(\d{4}-\d{2}-\d{2})-[a-z0-9][a-z0-9-]*$/;

function isStringArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/**
 * An imported module's `frontmatter` export, checked against the contract.
 *
 * Pure and total: it either returns a valid `IncidentFrontmatter` or throws
 * naming the file and the field. TypeScript cannot type a computed `import()`
 * specifier, so the module arrives as `unknown` whatever we do — this is the
 * one place that turns it into the contract, rather than spreading unchecked
 * property access across the page. A notice with a bad field is a build-time
 * shout, never a heading rendering `undefined`.
 */
export function parseIncidentFrontmatter(file: string, value: unknown): IncidentFrontmatter {
  const at = `src/content/status/incidents/${file}.mdx`;
  const named = INCIDENT_FILE_PATTERN.exec(file);
  if (!named) {
    throw new Error(`${at}: a notice is named \`YYYY-MM-DD-slug.mdx\` (lower case, no spaces)`);
  }
  if (typeof value !== "object" || value === null) {
    throw new Error(`${at}: no \`export const frontmatter\``);
  }
  const fm = value as Record<string, unknown>;
  const { date, title, status, components } = fm;
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`${at}: frontmatter.date is missing or is not \`YYYY-MM-DD\``);
  }
  if (date !== named[1]) {
    throw new Error(`${at}: frontmatter.date is ${date} but the file is filed under ${named[1]}`);
  }
  if (typeof title !== "string" || title.length === 0) {
    throw new Error(`${at}: frontmatter.title is missing or empty`);
  }
  if (typeof status !== "string" || !(INCIDENT_STATUSES as readonly string[]).includes(status)) {
    throw new Error(`${at}: frontmatter.status must be one of ${INCIDENT_STATUSES.join(", ")}`);
  }
  if (!isStringArray(components) || components.length === 0) {
    throw new Error(`${at}: frontmatter.components must list at least one component`);
  }
  for (const component of components) {
    if (typeof component !== "string" || !(STATUS_COMPONENT_IDS as readonly string[]).includes(component)) {
      throw new Error(
        `${at}: frontmatter.components names ${String(component)}, which is not one of ${STATUS_COMPONENT_IDS.join(", ")}`,
      );
    }
  }
  return {
    date,
    title,
    status: status as IncidentStatus,
    components: components as readonly StatusComponentId[],
  };
}

/**
 * Newest first, by the date the notice carries — not by the manifest's order,
 * which is authoring order and would silently bury a back-filled notice.
 *
 * `YYYY-MM-DD` sorts correctly as a string, which is the whole reason the
 * contract fixes that format. The sort is STABLE (ES2019), so two notices
 * dated the same day keep the order the manifest lists them in; that is the
 * only thing manifest order decides here, and it is asserted rather than
 * assumed.
 */
export function sortIncidents<T extends IncidentNotice>(notices: readonly T[]): T[] {
  return [...notices].sort((a, b) => {
    if (a.frontmatter.date === b.frontmatter.date) return 0;
    return a.frontmatter.date < b.frontmatter.date ? 1 : -1;
  });
}

export { incidentsManifest };
