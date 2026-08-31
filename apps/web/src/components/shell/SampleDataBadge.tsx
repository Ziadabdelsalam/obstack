"use client";

import { usePathname } from "next/navigation";
import { isLiveWiredRoute, isProductChromeRoute } from "@/lib/live-routes";

/**
 * D21: in live mode every surface that is not yet wired to the facade still
 * renders mock content, and says so — persistently, on every unwired route.
 *
 * A client component because reading the URL on the server is not supported
 * (node_modules/next/dist/docs/01-app/03-api-reference/04-functions/use-pathname.md);
 * the layout decides the mode, this decides the route.
 */
export function SampleDataBadge() {
  const pathname = usePathname();
  // D321: product chrome is neither wired nor sample — `/app/docs` renders the
  // same true corpus as the public `/docs`, so this badge over it would be a
  // claim about the docs, not about the data. Checked first, because chrome is
  // not in the wired set and would otherwise fall through to the badge.
  if (isProductChromeRoute(pathname)) return null;
  if (isLiveWiredRoute(pathname)) return null;
  return (
    <div
      className="flex items-center gap-2 border-b px-4 py-1.5"
      style={{
        borderColor: "color-mix(in srgb, var(--color-warn) 30%, var(--color-line))",
        background: "color-mix(in srgb, var(--color-warn) 6%, transparent)",
      }}
    >
      <span
        className="font-mono text-[11px] tracking-wide"
        style={{ color: "var(--color-warn)" }}
      >
        SAMPLE DATA — preview
      </span>
      <span className="hidden font-mono text-[11px] text-faint sm:inline">
        this surface still renders demo content; real telemetry lands here as it is wired up
      </span>
    </div>
  );
}
