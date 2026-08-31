/**
 * The measure and rhythm around a rendered MDX body.
 *
 * Deliberately thin: what each ELEMENT looks like is decided once in
 * `src/mdx-components.tsx` (the seam the MDX guide names for styling,
 * `node_modules/next/dist/docs/01-app/02-guides/mdx.md:330`), so this wrapper
 * only owns the things a component map cannot see — the column width and the
 * fact that the first heading should not carry a top margin it inherited from
 * being "the next block".
 *
 * A server component with no state: it is the same element tree on both
 * mounts, in both images.
 */
export function Prose({ children }: { children: React.ReactNode }) {
  return (
    <div className="max-w-[46rem] [&>*:first-child]:mt-0 [&>h2:first-child]:border-t-0 [&>h2:first-child]:pt-0">
      {children}
    </div>
  );
}
