import Link from "next/link";
import { hrefFor } from "@/lib/docs/docs";
import type { DocsNavSectionWithTitles } from "@/lib/docs/load";

/**
 * The docs sidebar. Sections and order come straight from the manifest
 * (D320 — nav order IS array order); titles come from each page's
 * `frontmatter` export. Nothing here is hand-maintained, so a page cannot
 * appear in the nav without existing or exist without appearing.
 *
 * `basePath` is THE only thing that differs between the two mounts: `/docs`
 * for the public site, `/app/docs` inside the shell. A reader who is already
 * in the app stays in the app; a stranger on the marketing host stays on the
 * marketing host. Both read the same pages.
 *
 * A server component — the active page is known from the slug the route
 * already resolved, so there is no reason to ship a `usePathname` to the
 * browser for it.
 */
export function DocsNav({
  sections,
  basePath,
  activeSlug,
}: {
  sections: readonly DocsNavSectionWithTitles[];
  basePath: string;
  activeSlug: readonly string[];
}) {
  const activeHref = hrefFor(basePath, activeSlug);
  return (
    <nav aria-label="Docs" className="flex flex-col gap-5">
      {sections.map((section) => (
        <div key={section.section} className="flex flex-col gap-1">
          <p className="px-2 font-mono text-[10px] tracking-wide text-faint uppercase">
            {section.section}
          </p>
          {section.items.map((item) => {
            const href = hrefFor(basePath, item.entry.slug);
            const active = href === activeHref;
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? "page" : undefined}
                className={`rounded-md px-2 py-1 text-[12.5px] ${
                  active ? "bg-raised text-ink" : "text-mid hover:text-ink"
                }`}
              >
                {item.title}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
