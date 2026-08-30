/**
 * THE words this product uses to say "none of this happened" (D326).
 *
 * There is exactly one definition because there is exactly one claim. Until
 * S4.4 the landing page carried a single copyright-line clause calling the site
 * a prototype whose data was invented, and it stood as the only label over the
 * hero trace, the hero video and the four screenshots at once; inside `/app`
 * the same idea was spelled out again, differently, in the shell's demo footer.
 * Two spellings of one claim drift. So the sentence became a constant, the
 * surfaces import it, and that footer line went back to being a copyright (the
 * fence's §6 finding).
 *
 * Client-safe on purpose: `HeroTrace` and `ScreensShowcase` are `"use client"`
 * components and the landing page is a Server Component — one constant, both
 * sides, no `server-only` and no environment read.
 *
 * Every consumer is enforced rather than remembered: `app/landing-fence.test.ts`
 * fails any file under `components/marketing/**` (or `app/page.tsx`) that
 * imports the mock corpus, references `/shots/` or names an `.mp4` without
 * importing this constant. Adding a fabricated surface without labelling it is
 * therefore red, which is the whole point of removing the blanket footer.
 */
export const SAMPLE_COPY = "sample data from a fictional company";
