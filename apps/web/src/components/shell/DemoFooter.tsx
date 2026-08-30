"use client";

import { usePathname } from "next/navigation";
import { isProductChromeRoute } from "@/lib/live-routes";

/**
 * D134/D228: in mock mode — the public demo — nothing on screen said the
 * product was a demo. The sample-data badge is live-mode-only by construction
 * (it marks the unwired routes inside a real workspace), so a stranger could
 * read every screen of the demo without being told once that none of it
 * happened.
 *
 * A slim persistent bar in the shell, so every mock surface carries it and no
 * page has to remember to. Live mode never renders it: there the badge speaks
 * per route, and this sentence would be false about the wired ones — that gate
 * stays in `app/app/layout.tsx` (`{!live && <DemoFooter />}`), which is where
 * the mode is known.
 *
 * D321 — why this left the layout: `/app/docs` renders the same MDX corpus the
 * public `/docs` serves, and the mock-mode image is the marketing host (D262).
 * Under the layout's old unconditional render, a stranger reading a real
 * self-hosting instruction on the demo was told underneath it that "every
 * screen here is sample data from a fictional company — nothing is being
 * ingested". That is the inverse of the lie D134 added this bar to prevent: a
 * true page labelled false. The route it must not appear on is a per-route
 * fact, and a route is only readable on the client
 * (node_modules/next/dist/docs/01-app/03-api-reference/04-functions/use-pathname.md),
 * so the bar becomes a client component with the same shape as
 * `SampleDataBadge` beside it — mode from the parent, route from here.
 *
 * The wording is unchanged from the layout's copy, character for character; it
 * is pinned by `shell-honesty.test.ts`.
 */
export function DemoFooter() {
  const pathname = usePathname();
  if (isProductChromeRoute(pathname)) return null;
  return (
    <div
      className="flex shrink-0 items-center gap-2 border-t px-4 py-1.5"
      style={{
        borderColor: "color-mix(in srgb, var(--color-warn) 30%, var(--color-line))",
        background: "color-mix(in srgb, var(--color-warn) 6%, transparent)",
      }}
    >
      <span className="font-mono text-[11px] tracking-wide" style={{ color: "var(--color-warn)" }}>
        DEMO WORKSPACE
      </span>
      <span className="font-mono text-[11px] text-faint">
        every screen here is sample data from a fictional company — nothing is being ingested
      </span>
    </div>
  );
}
