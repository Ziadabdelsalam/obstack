# Incident notices — the contract

Everything in this directory is published by `/status` (`src/app/status/page.tsx`),
newest first. The directory is **empty at launch**, and the page says
"No incidents recorded." — which is true, and is the only honest thing a status
page with no monitor behind it can say about its history.

## An incident file is written by a person

Nothing generates one. There is no monitor, no alert rule and no automation
that can create a file here: a notice exists because somebody decided obstack
owed its users an account of something that happened, and wrote it. That is
D256's "manually curated" in the concrete — the page has no bespoke backend and
does not claim one.

The corollary is that this directory being empty is not evidence of anything.
It means no notice has been published, not that nothing has ever gone wrong.
The Monitoring section on the page says what is actually known.

## One notice = one file

```
src/content/status/incidents/2026-09-14-ingest-backlog.mdx
```

The name is `YYYY-MM-DD-slug.mdx`, and the date in the name must equal the
`date` in the frontmatter — `incidents.test.ts` fails on a file whose two dates
disagree, so a notice cannot be filed under one day and read as another.

## Frontmatter is a named export, not YAML

`@next/mdx` does not support YAML frontmatter
(`node_modules/next/dist/docs/01-app/02-guides/mdx.md:622`) but does support any
named export (`:628-643`), so every notice begins:

```mdx
export const frontmatter = {
  date: "2026-09-14",
  title: "Delayed ingest for OTLP traces",
  status: "resolved",
  components: ["ingest"],
};

Traces sent between 09:12 and 10:04 UTC were accepted but appeared in the
workspace up to forty minutes late. ...
```

- `date` — **required**, `YYYY-MM-DD`, a plain string literal. It orders the
  page and must match the file name's prefix.
- `title` — **required**, a plain string literal. One line, what happened.
- `status` — **required**, one of `investigating`, `monitoring`, `resolved`.
  It is the state of the notice as last edited by its author; nothing updates
  it on its own, so an `investigating` notice that has stopped moving is a
  notice somebody needs to finish.
- `components` — **required**, a non-empty list of the ids the status page
  lists: `app`, `ingest`, `docs`. The ids are defined once, in
  `src/lib/docs/incidents.ts`; an id that is not one of them is a red test.

Every field is read as text by `incidents.test.ts` (the runner has no MDX
loader), so each value must be a plain string literal — not computed, not
imported.

## Registration

Add one entry to `manifest.ts` beside this one, naming the file twice — once as
its key and once as a literal `import()`:

```ts
{ file: "2026-09-14-ingest-backlog", load: () => import("./2026-09-14-ingest-backlog.mdx") },
```

The import is written out rather than computed from `file` on purpose, and the
reason is measured: a computed specifier makes Turbopack glob this directory
for a context module, and a directory holding no `.mdx` at all fails the build.
An incident directory is empty exactly when the product is behaving, so the
form that survives an empty directory is the right one. `manifest.ts` carries
the full note.

A notice with no entry is never published, an entry with no file is a build
error, and an entry whose `import()` names a different file than its `file` is
a notice published under somebody else's date. `incidents.test.ts` fails on all
three, rather than letting one be discovered from the page.

## What a notice may NOT contain

- **No uptime number, no percentage, no availability figure.** obstack runs no
  external uptime monitor yet (D256), so any number of that kind on this page
  would be invented. `status.test.ts` fails on a digit followed by `%`.
- **No mode branch and no mock data.** `/status` is mode-blind: nothing here or
  in `src/lib/docs/incidents*.ts` may import `@/mock/*` or call `resolveMode()`.
- **No fabricated host, credential or command** — `src/mock/corpus-honesty.test.ts`
  reads this whole tree as text and bans them.
