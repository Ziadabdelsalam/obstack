import type { ComponentPropsWithoutRef } from "react";
import Link from "next/link";
import { MDX_ANCHOR_CLASS } from "@/mdx-components";
import { isInternalHref, rebaseDocsHref } from "@/lib/docs/doc-href";

/**
 * The `a` a docs body renders with — the one component that knows which mount
 * it is on.
 *
 * MECHANISM (`mdx.md:414-435`, "Local styles and components"): the compiled MDX
 * default export takes a `components` prop, and it MERGES WITH AND OVERRIDES
 * the global map from `src/mdx-components.tsx`. `DocsPage` passes `{ a: … }`,
 * so every link in every body goes through here without a single page having to
 * know, and the authoring convention stays one absolute `/docs/...` href per
 * link (which is also what makes them checkable against the manifest).
 *
 * Because the prop OVERRIDES rather than wraps, the styling is not inherited —
 * hence `MDX_ANCHOR_CLASS`, imported from the map so there is still exactly one
 * definition of what a link looks like.
 *
 * A factory rather than a component with a `basePath` prop: MDX decides the
 * props of the elements it renders, and `basePath` is not one of them.
 */
export function docLinkFor(basePath: string) {
  return function DocLink({ href, ...props }: ComponentPropsWithoutRef<"a">) {
    const rebased = rebaseDocsHref(href, basePath);
    if (rebased !== null) {
      return <Link className={MDX_ANCHOR_CLASS} href={rebased} {...props} />;
    }
    // Another page of this site, unchanged: `/status` is `/status` from either
    // mount. Still `next/link`, because it is still a client-side navigation.
    if (isInternalHref(href)) {
      return <Link className={MDX_ANCHOR_CLASS} href={href} {...props} />;
    }
    // External, `#anchor`, `mailto:` — a plain anchor, exactly as authored.
    return <a className={MDX_ANCHOR_CLASS} href={href} {...props} />;
  };
}
