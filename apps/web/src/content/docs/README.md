# The docs corpus — conventions

Everything under `src/content/docs/**` is rendered by ONE component
(`@/components/docs/DocsPage`) onto TWO mounts:

| mount | route file | audience |
| --- | --- | --- |
| `/docs/*` | `src/app/docs/[[...slug]]/page.tsx` | public, unauthenticated, `● SSG` |
| `/app/docs/*` | `src/app/app/docs/[[...slug]]/page.tsx` | inside the app shell |

The two differ by exactly one prop (`basePath`), and nothing else about a page
may depend on where it is mounted.

`basePath` reaches two things. The nav builds its hrefs from it, and so do the
links inside the prose: a page is authored with absolute `/docs/...` hrefs, and
`DocsPage` passes an `a` component to the compiled MDX body
(`components={{ a: DocLink }}` — the MDX `components` prop merges with and
overrides `src/mdx-components.tsx`, `mdx.md:414-435`) which rebases those hrefs
onto the mount being rendered. So a body link opened from `/app/docs/quickstart`
keeps a signed-in reader in the shell, while the same link on `/docs/quickstart`
renders unchanged. Write `/docs/...` and nothing else — an in-app URL written
into a page would be wrong on the public mount, and `doc-links.test.ts` fails on
one. It also checks every such link against the manifest, and checks the
rendered result on both mounts against the prerendered HTML.

## One page = one directory + one `index.mdx`

```
src/content/docs/index.mdx                    ->  /docs
src/content/docs/quickstart/index.mdx         ->  /docs/quickstart
src/content/docs/sdks/typescript/index.mdx    ->  /docs/sdks/typescript
```

The slug is the directory path; the file is always `index.mdx`. A `.mdx` file
by any other name is unreachable, and `docs.test.ts` fails on one rather than
letting it sit there looking published. (The uniform filename is also what
lets the loader's dynamic `import()` keep the single-interpolation form
Turbopack requires — see `src/lib/docs/load.ts`.)

## Frontmatter is a named export, not YAML

`@next/mdx` does not support YAML frontmatter
(`node_modules/next/dist/docs/01-app/02-guides/mdx.md:622`) but does support
any named export (`:628-643`). So every page begins:

```mdx
export const frontmatter = { title: "Quickstart", description: "One sentence." };

# Quickstart
```

- `title` — **required**, a plain string literal. It is the nav label, the
  `<title>`, and the card text. Not optional, not computed: `docs.test.ts`
  reads this file as text and requires a string literal, because the test
  runner (`tsx --conditions react-server`) has no MDX loader and cannot
  import a page to ask it.
- `description` — optional string literal; becomes the page's meta
  description.

Keep the `# H1` in the body too. The title export is metadata; the heading is
the document.

## Registration

Add the page to `manifest.ts` in the position it should occupy in the nav.
Nav order is array order, sections group in first-appearance order. A page with
no manifest entry, or an entry with no page, is a red test — not a 404 someone
finds later.

## What a page may contain

- MDX: markdown plus imported React components (`mdx.md:152`). GFM tables,
  strikethrough and task lists are on (`remark-gfm`); every heading gets an
  `id` (`rehype-slug`), so `/docs/quickstart#send-your-first-trace` works.
- Element styling comes from `src/mdx-components.tsx`. A page does not carry
  its own classes.

## What a page may NOT contain

- **No mode branch and no mock data.** The `live` and `mock` web images are
  built from one source and must serve byte-identical docs (D251/D267), so
  nothing under `src/content/**`, `src/lib/docs/**` or `src/components/docs/**`
  may import `@/mock/*` or call `resolveMode()`. Pinned by test.
- **No hand-copied snippet that a component already defines.** Command strings,
  endpoints and SDK versions are interpolated from their one definition — the
  quickstart's tabs come from the shared snippet module (D322, T2's boundary),
  the OTLP endpoints from `@/lib/ingest-endpoint`. A second copy in prose is a
  second definition that goes stale silently. Enforced:
  `components/onboarding/Quickstart.test.ts` reads every `.mdx` page in this
  tree and fails on any line carrying one of the three install/exporter forms it
  names — deliberately not spelled here, the D246 discipline that keeps a
  sweep's needles out of the files it sweeps. An install command or an OTLP
  exporter variable reaches a page through
  `@/components/docs/QuickstartSnippets` or not at all.
- **No fabricated host, credential or command.** `src/mock/corpus-honesty.test.ts`
  reads this whole tree as text and bans them.

`corpus-honesty.test.ts`'s helm assertion — "every helm command in the docs
installs a chart that exists in-repo" — is on its **strict branch** now: the
self-hosting page carries the real `helm install` line, so the test resolves
every chart path in the corpus against the repository. The fail-closed marker
that stood here while the corpus had no helm command at all is gone with the
command's arrival, which is the transition it was written for.
