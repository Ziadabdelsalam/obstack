import path from "node:path";
import { fileURLToPath } from "node:url";

/** `apps/web/src` — every `@/…` alias resolves relative to this directory. */
const SRC_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** A static `from "…"`/`from '…'` specifier, or a dynamic `import("…")` one. */
const IMPORT_SPEC = /\bfrom\s+["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g;

/**
 * Every import specifier `source` names, with relative ones (`./…`, `../…`)
 * resolved against `filePath`'s directory to the repo-rooted `@/…` form —
 * the SAME string an alias-spelled import of the same module would produce.
 * Aliased (`@/…`) and bare-package (`react`, `next/navigation`,
 * `lucide-react`, …) specifiers pass through unchanged.
 *
 * D448: every `app/app/**\/page.test.ts` source-text ban ("no `@/mock/`, no
 * `workspace-store`, no `ExploreChart`, no `WidgetCard`, …") used to match
 * the literal `@/`-aliased spelling only. `dashboards/page.test.ts`'s review
 * (cae5638) found `../../mock/dashboards` and `./WidgetCard` both passing
 * every ban green — the SAME import, spelled relatively. This is the one
 * resolver every such guard now shares (no second copy, D448) so a ban reads
 * what an import RESOLVES to, never the one spelling someone happened to
 * type.
 */
export function resolvedImports(source: string, filePath: string): string[] {
  const dir = path.dirname(filePath);
  const specifiers: string[] = [];
  for (const match of source.matchAll(IMPORT_SPEC)) {
    const spec = match[1] ?? match[2];
    specifiers.push(resolveOne(spec, dir));
  }
  return specifiers;
}

function resolveOne(spec: string, dir: string): string {
  if (!spec.startsWith(".")) return spec; // an alias (`@/…`) or a bare package
  const abs = path.resolve(dir, spec);
  const rel = path.relative(SRC_ROOT, abs).split(path.sep).join("/");
  return `@/${rel}`;
}
