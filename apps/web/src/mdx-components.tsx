import type { MDXComponents } from "mdx/types";

/**
 * The MDX element map for the whole docs corpus (D319).
 *
 * `mdx-components.tsx` at the `src/` root is REQUIRED for `@next/mdx` under
 * the App Router — "will not work without it"
 * (node_modules/next/dist/docs/01-app/02-guides/mdx.md:109) — and the file
 * convention states that the exported `useMDXComponents` "does not accept any
 * arguments" (`.../03-api-reference/03-file-conventions/mdx-components.md:36`).
 * That is the breaking change AGENTS.md warns about: the pre-16 signature took
 * the inherited components as a parameter and merged them. Here the map IS the
 * definition, so there is nothing to merge.
 *
 * THE RULE, measured (NX3): every override spreads `...props`. `rehype-slug`
 * (wired in `next.config.ts`) puts the heading `id` on the element as a prop;
 * an override that writes its own attributes without spreading drops that id
 * silently — the page still renders, and every in-page anchor is dead. The
 * `mdx-components spread` test in `src/lib/docs/docs.test.ts` reads this file
 * and fails on an override that does not spread.
 *
 * Styling lives here rather than in a wrapper stylesheet because this is the
 * seam the guide names for it ("Using custom styles and components",
 * `mdx.md:330`): the MDX body is plain HTML elements, and this map is the one
 * place that decides what each one looks like. `Prose` around the body only
 * sets measure and rhythm.
 */
/**
 * What a link looks like, defined once. `@/components/docs/DocLink` needs it
 * too: `DocsPage` passes an `a` through the MDX `components` prop, and that
 * prop OVERRIDES this map's entry rather than wrapping it (`mdx.md:414-435`),
 * so the override has to carry the styling itself or a rebased link would be
 * the one link on the page that is not underlined.
 */
export const MDX_ANCHOR_CLASS = "underline decoration-line-strong underline-offset-2 hover:text-ink";

const components: MDXComponents = {
  h1: (props) => (
    <h1
      className="font-display scroll-mt-24 text-[26px] font-bold tracking-tight text-ink"
      {...props}
    />
  ),
  h2: (props) => (
    <h2
      className="font-display mt-10 scroll-mt-24 border-t border-line pt-6 text-[18px] font-semibold text-ink"
      {...props}
    />
  ),
  h3: (props) => (
    <h3 className="mt-7 scroll-mt-24 text-[15px] font-semibold text-ink" {...props} />
  ),
  h4: (props) => (
    <h4 className="mt-6 scroll-mt-24 text-[13.5px] font-semibold text-ink" {...props} />
  ),
  p: (props) => <p className="mt-3.5 text-[13.5px] leading-relaxed text-mid" {...props} />,
  ul: (props) => (
    <ul className="mt-3.5 flex list-disc flex-col gap-1.5 pl-5 text-[13.5px] leading-relaxed text-mid" {...props} />
  ),
  ol: (props) => (
    <ol className="mt-3.5 flex list-decimal flex-col gap-1.5 pl-5 text-[13.5px] leading-relaxed text-mid" {...props} />
  ),
  li: (props) => <li className="pl-1" {...props} />,
  a: (props) => <a className={MDX_ANCHOR_CLASS} {...props} />,
  strong: (props) => <strong className="font-semibold text-ink" {...props} />,
  blockquote: (props) => (
    <blockquote
      className="mt-4 border-l-2 border-line-strong pl-4 text-[13.5px] leading-relaxed text-mid italic"
      {...props}
    />
  ),
  hr: (props) => <hr className="mt-8 border-line" {...props} />,
  // `pre` is the block; `code` is both the inline span and the child of `pre`.
  //
  // The font size on `code` is therefore CONDITIONAL, and that is measured, not
  // stylistic: `text-[12px]` here and `text-[11.5px]` on `pre` are
  // equal-specificity single classes, so whichever Tailwind emits later wins
  // everywhere — and in the prerendered HTML it was this one, inside fenced
  // blocks included. The visible symptom was on `/docs/quickstart`, which mixes
  // MDX fences with the bare `<pre>` blocks `@/components/docs/QuickstartSnippets`
  // renders: the same page showed code at two sizes, 12px in the fences and
  // 11.5px in the component's blocks. `[&:not(pre_&)]` scopes the size to the
  // INLINE case, which is the only case it was ever about; everything else on
  // `code` — the mono face, the rounding — is wanted in both, so a block is now
  // sized by `pre` alone.
  pre: (props) => (
    <pre
      className="mt-4 overflow-x-auto rounded-md border border-line bg-raised p-3 font-mono text-[11.5px] leading-relaxed text-ink"
      {...props}
    />
  ),
  code: (props) => (
    <code className="rounded-[3px] font-mono text-ink [&:not(pre_&)]:text-[12px]" {...props} />
  ),
  // remark-gfm's tables (next.config.ts). They scroll inside their own box
  // rather than widening the page.
  table: (props) => (
    <div className="mt-4 overflow-x-auto">
      <table className="w-full border-collapse text-[12.5px]" {...props} />
    </div>
  ),
  th: (props) => (
    <th
      className="border-b border-line-strong px-2.5 py-1.5 text-left font-medium text-ink"
      {...props}
    />
  ),
  td: (props) => (
    <td className="border-b border-line px-2.5 py-1.5 align-top text-mid" {...props} />
  ),
};

export function useMDXComponents(): MDXComponents {
  return components;
}
