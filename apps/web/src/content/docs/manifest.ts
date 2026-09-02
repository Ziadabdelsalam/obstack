/**
 * THE docs manifest (D320) — the source of truth for what pages exist, what
 * order they are in, and which section they belong to.
 *
 * Why a hand-written list rather than a filesystem walk: `/app/docs/*` renders
 * PER REQUEST in the live image, because `app/app/layout.tsx:110-112` calls
 * `connection()` and resolves a session before the shell renders. A page that
 * discovered its siblings with `fs` would therefore be doing a directory walk
 * on every request inside a container whose working tree is a traced
 * `.next/standalone` copy — the one shape NX3 never measured. So no module
 * that ships reads the filesystem: this array is the whole index, it compiles
 * into the bundle, and `src/lib/docs/docs.test.ts` walks the tree with `fs` at
 * TEST time and fails if the two ever disagree in either direction (D206
 * mirror shape).
 *
 * NAV ORDER IS ARRAY ORDER. Sections are grouped in first-appearance order,
 * and the entries inside a section keep the order they have here — there is no
 * `order:` field to drift out of sync with the list it sorts.
 *
 * ADDING A PAGE (the whole procedure):
 *   1. create `src/content/docs/<slug>/index.mdx` — see `README.md` beside this
 *      file for the frontmatter contract;
 *   2. add one entry here, in the position it should appear in the nav.
 * Doing either half alone turns `docs.test.ts` red, which is the point.
 */

/** A page's address: the URL segments after the mount, `[]` for the index. */
export interface DocsManifestEntry {
  /** `[]` → `/docs`; `["quickstart"]` → `/docs/quickstart`. */
  readonly slug: readonly string[];
  /** The nav heading this page files under. Grouped in first-appearance order. */
  readonly section: string;
}

export const docsManifest: readonly DocsManifestEntry[] = [
  { slug: [], section: "Start here" },
  { slug: ["quickstart"], section: "Quickstart" },
  { slug: ["sdks", "typescript"], section: "SDKs" },
  { slug: ["sdks", "python"], section: "SDKs" },
  { slug: ["sdks", "bring-your-own-otel"], section: "SDKs" },
  { slug: ["self-hosting", "docker-compose"], section: "Self-hosting" },
  { slug: ["self-hosting", "helm-chart"], section: "Self-hosting" },
  { slug: ["connectors", "overview"], section: "Connectors" },
  { slug: ["connectors", "vercel-log-drains"], section: "Connectors" },
  { slug: ["connectors", "aws-cloudwatch"], section: "Connectors" },
  { slug: ["connectors", "github-actions"], section: "Connectors" },
  { slug: ["explain"], section: "Features" },
  { slug: ["retention"], section: "Features" },
  { slug: ["billing-and-plans"], section: "Plans" },
  { slug: ["what-obstack-does-not-do"], section: "Absences" },
];
