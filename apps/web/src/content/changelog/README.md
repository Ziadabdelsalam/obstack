# The changelog corpus — conventions

Every file under `src/content/changelog/**` is one release note. `/changelog`
(`src/app/changelog/page.tsx`) renders all of them, newest first, and that page
is the only thing that reads them. There is no per-entry route.

Before the S4.4 pass these four entries were a hardcoded array inside the page,
and the posture below lived in a docblock above it. Both moved here (D255): a
release note is content, so it belongs in the same tree the docs use, on the
same pipeline, swept by the same tests.

## What an entry may say

**Every entry names something the product does when you run it (D229).** That
is the whole editorial rule, and it is the reason this file is short: the
entries have nothing in them to police except that.

Four earlier entries announced surfaces that exist only as demo content — the
service map, Issues/Incidents/SLOs, trace diff, Pipelines, the customizable
Overview, the infra track. They were **deleted rather than softened**: an entry
with no true referent has nothing to reword into. The rest were rewritten down
to what actually shipped, which is why:

- the two-word streaming-tail claim that `src/components/shell/TourGuide.test.ts`
  bans (D48/D60) appears in no entry — and is not spelled here either, because
  that sweep reads every checked-in file including this one, so a file that
  spells the claim in order to discuss it becomes a hit like any other;
- the closing sentence of `2026-08-17-logs-explorer.mdx` states the absence of
  that behaviour on purpose. It is not an apology and it is not filler: it is
  the sentence that keeps the entry above it true;
- the "at launch" Vercel and CloudWatch claims are gone. The connections hub
  marks both coming-soon (D208), and an entry may not promise what the product
  itself declines to promise.

**D246 coverage:** the repo-wide sweep in `TourGuide.test.ts` walks this
directory the same as any other — `src/content/**` is not on its skip list —
so the ban follows the content here. `TourGuide.test.ts` asserts that its
scanned set actually includes a file under `src/content/changelog/` and one
under `src/content/docs/`, so "the coverage survived the move" is pinned rather
than believed.

## The date rule

**An entry's date is the master merge date of the PR that made the entry
true** (D323) — not the day the note was written, not the day the branch was
cut. A changelog date is a claim about when a stranger could first have had
the thing, and the only record of that is `git log --merges master`.

The four dates the hardcoded array carried were wrong in three cases: the repo
did not exist on the earliest of them. Each file names its merge in an MDX
comment on the line under its frontmatter:

```mdx
{/* merged: <sha> PR #<n>, <YYYY-MM-DD> */}
```

That comment is the entry's evidence. Keep it when you edit an entry; write it
from `git log --merges --format='%H %ad %s' --date=short master` when you add
one.

## The file shape

One entry = one file, named for its date:

```
src/content/changelog/2026-08-17-logs-explorer.mdx   ->  the 2026-08-17 entry
```

The `YYYY-MM-DD` prefix must equal `frontmatter.date`; `changelog.test.ts`
fails on a file where they disagree, so the directory listing and the rendered
page can never tell different stories.

Frontmatter is a named export, not YAML (`@next/mdx` does not support YAML —
`node_modules/next/dist/docs/01-app/02-guides/mdx.md:622`, named exports at
`:628-643`), and every value is a plain string literal, because the test runner
(`tsx --conditions react-server`) has no MDX loader and reads these files as
text:

```mdx
export const frontmatter = {
  date: "2026-08-17",
  kind: "new",
  title: "Logs explorer",
};
```

- `date` — **required**, `YYYY-MM-DD`, per the date rule above. It is the sort
  key for the whole page.
- `kind` — **required**, `"new"` or `"improved"`. It picks the badge. A third
  value needs a colour in `src/app/changelog/page.tsx` and a widened union in
  `src/lib/docs/changelog.ts`; TypeScript will say so.
- `title` — **required**, a plain string literal.

The body is the note itself: one paragraph of prose, no heading. The title
comes from the frontmatter and the page renders it, so an `# H1` in the body
would print it twice.

## Registration

Add the slug to `manifest.ts`. A file with no entry is never rendered; an entry
with no file is a build error. `changelog.test.ts` fails on either, in both
directions, so neither is something to discover from the live page.

## The byte pin

The four migrated entries' bodies are pinned byte-for-byte in
`src/lib/docs/changelog.test.ts`, against the text as it stood in
`app/changelog/page.tsx` at `3edc49b`. The migration was a move, not a rewrite,
and the pin is what makes that checkable. Editing one of those four is allowed
— it just has to be deliberate: change the file and change its pin in the same
commit, and say why.

## What an entry may NOT contain

- **No mode branch and no mock data.** Nothing under `src/content/**` or
  `src/lib/docs/**` may import a mock module or ask which data mode the app is
  running in: the `live` and `mock` images are one build (D251/D267) and must
  serve the same words. `src/lib/docs/changelog.test.ts` reads these files as
  text and refuses both edges. Neither the import path nor the mode helper is
  named here, for the same reason the claim above is not: the grep that audits
  this directory would count the sentence describing the ban as a breach of
  it.
- **No claim the sweep bans**, in either spelling or any casing (D48/D60).
