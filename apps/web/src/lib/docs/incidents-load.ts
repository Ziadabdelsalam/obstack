import type { ComponentType } from "react";
import {
  incidentsManifest,
  parseIncidentFrontmatter,
  sortIncidents,
  type IncidentFrontmatter,
  type IncidentManifestEntry,
  type IncidentNotice,
} from "./incidents";

/**
 * The half of the incidents loader that reaches actual notices (D320): it
 * pulls each manifested module in, checks what it declares, and orders the
 * result. Everything here runs inside modules Next compiles.
 *
 * NO `fs`, NO `path`, on any code path — the same rule the docs loader carries
 * (`./load.ts`), for the same reason: the manifest is compiled in and the MDX
 * modules are bundled beside it, so there is nothing to walk.
 *
 * There is no `notFound()` counterpart here, because `/status` has no dynamic
 * segment: the whole list is one page. The manifest is still THE gate — a file
 * that is not in it is not published.
 */

/** A notice, ready to render: its declared frontmatter plus its compiled body. */
export interface LoadedIncident extends IncidentNotice {
  readonly Body: ComponentType;
}

/**
 * One notice, imported and checked.
 *
 * The `import()` itself is in the manifest, one literal per entry, NOT a
 * computed specifier here. That is a departure from the docs loader
 * (`./load.ts`), and it is measured rather than stylistic: on next 16.3.0 a
 * computed specifier makes Turbopack glob the directory for a context module,
 * and a directory with no `.mdx` in it fails the build with
 * `Can't resolve '@/content/status/incidents/' <dynamic> '.mdx'`. This
 * directory is empty at launch and should stay empty — the manifest's docblock
 * carries the full note. The docs need the computed form because their slug
 * arrives from the URL; here the whole list is known at build time, so nothing
 * has to be computed.
 *
 * What this module still owns is the CHECK: a module reached through a
 * `() => Promise<IncidentModule>` is `unknown` at its frontmatter, and
 * `parseIncidentFrontmatter` is the one place that turns it into the contract.
 */
async function importNotice(entry: IncidentManifestEntry): Promise<LoadedIncident> {
  const mod = await entry.load();
  const frontmatter: IncidentFrontmatter = parseIncidentFrontmatter(entry.file, mod.frontmatter);
  return { file: entry.file, frontmatter, Body: mod.default };
}

/**
 * Every published notice, newest first.
 *
 * Returns `[]` when the manifest is empty — which it is at launch, and the
 * page renders the empty state rather than inventing a history
 * (`src/content/status/incidents/README.md`).
 */
export async function loadIncidents(): Promise<LoadedIncident[]> {
  const loaded = await Promise.all(incidentsManifest.map(importNotice));
  // Ordering lives in the pure module so the test can drive it with fixtures
  // instead of needing files on disk.
  return sortIncidents(loaded);
}
