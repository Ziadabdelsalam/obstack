# The docs corpus — conventions

Everything under `src/content/docs/**` is rendered by ONE component
(`@/components/docs/DocsPage`) onto TWO mounts:

| mount | route file | audience |
| --- | --- | --- |
| `/docs/*` | `src/app/docs/[[...slug]]/page.tsx` | public, unauthenticated, `● SSG` |
| `/app/docs/*` | `src/app/app/docs/[[...slug]]/page.tsx` | inside the app shell |

The two differ by exactly one prop (`basePath`, which the nav links against).
Nothing else about a page may depend on where it is mounted.

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
  second definition that goes stale silently.
- **No fabricated host, credential or command.** `src/mock/corpus-honesty.test.ts`
  reads this whole tree as text and bans them.

<!-- T2: helm command pending -->

The marker above is load-bearing, not a note. `corpus-honesty.test.ts`'s helm
assertion ("every helm command in the docs installs a chart that exists
in-repo") cannot pass vacuously on a corpus that has no helm command yet: with
zero `helm install` lines in the tree it asserts this marker is present, so the
obligation is visible instead of silently satisfied by an empty corpus. When
T2 writes the self-hosting page with the real command, the assertion switches
to its strict branch on its own — delete the marker line then.
