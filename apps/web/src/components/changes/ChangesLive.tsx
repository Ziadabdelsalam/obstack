import Link from "next/link";
import { ArrowUpRight, Boxes, Flag, KeyRound, Rocket, Scaling, Settings2 } from "lucide-react";
import type { ChangeEventRow, ChangeKind } from "@/lib/change-types";

/**
 * Changes, live (S7.2 T5, D502): a SERVER component fed exclusively by
 * `server/changes.ts` through `changes/page.tsx`. No `@/mock/` import
 * anywhere in this file, and nothing interactive — v1 is webhook-fed
 * (packet §0), so there is no editor half.
 *
 * Absent rather than staged (D13, packet §0): the fixture's incident badge
 * (a real incident window is S7.4's to derive) and its product-internal
 * links. A live EVENT link is the SOURCE system's URL — the workflow run, the
 * commit — rendered as an external anchor; the endpoint refuses anything but
 * an absolute http(s) href (D499), which is what makes `target="_blank"`
 * safe to write here. The one `Link` in this file is the empty state's, to
 * the recipe page inside the product.
 *
 * The style table is this file's own copy: the mock page's `kindStyle`
 * cannot move without breaking its byte pin, and the VOCABULARY has one
 * definition (`ChangeKind`); the styling may exist twice.
 */
const kindStyle: Record<ChangeKind, { icon: typeof Rocket; color: string; label: string }> = {
  deploy: { icon: Rocket, color: "var(--color-agent)", label: "deploy" },
  config: { icon: Settings2, color: "var(--color-api)", label: "config" },
  scale: { icon: Scaling, color: "var(--color-tool)", label: "scale" },
  secret: { icon: KeyRound, color: "var(--color-warn)", label: "secret" },
  flag: { icon: Flag, color: "var(--color-llm)", label: "flag" },
  infra: { icon: Boxes, color: "var(--color-infra)", label: "k8s" },
};

/** ISO UTC → `YYYY-MM-DD HH:MM UTC`, the alerts feed's idiom. */
const clock = (iso: string): string => `${iso.slice(0, 16).replace("T", " ")} UTC`;

export function ChangesLive({ events }: { events: ChangeEventRow[] }) {
  return (
    <div className="mx-auto max-w-3xl px-5 py-4">
      <div className="mb-1 flex items-center justify-between">
        <h1 className="font-display text-[19px] font-semibold text-ink">Changes</h1>
        <span className="font-mono text-[11px] text-faint">
          deploys · config · scaling · secrets · flags — one answer to “what changed?”
        </span>
      </div>
      <p className="mb-5 text-[12.5px] text-mid">
        Everything your systems reported changing, newest first — posted to{" "}
        <code className="font-mono text-[11.5px]">POST /v1/changes</code> with your ingest key.
      </p>

      {events.length === 0 ? (
        <div className="rounded-lg border border-line bg-surface p-6 text-center">
          <p className="font-mono text-[13px] text-mid">
            no changes recorded yet — post one from CI
          </p>
          <Link
            href="/app/docs/connectors/github-actions"
            className="mt-2 inline-flex items-center gap-1 font-mono text-[11px] hover:underline"
            style={{ color: "var(--color-api)" }}
          >
            the GitHub Actions recipe <ArrowUpRight className="h-3 w-3" />
          </Link>
        </div>
      ) : (
        <div className="relative ml-2 border-l border-line-strong pl-6">
          {events.map((e) => {
            const s = kindStyle[e.kind];
            const Icon = s.icon;
            return (
              <div key={e.id} className="relative pb-5 last:pb-0">
                <span
                  className="absolute -left-[35px] flex h-[18px] w-[18px] items-center justify-center rounded-full border bg-surface"
                  style={{ borderColor: s.color }}
                >
                  <Icon className="h-2.5 w-2.5" style={{ color: s.color }} />
                </span>
                <div className="rounded-lg border border-line bg-surface p-3">
                  <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                    <span
                      className="font-mono text-[9px] uppercase tracking-widest"
                      style={{ color: s.color }}
                    >
                      {s.label}
                    </span>
                    <span className="font-mono text-[10.5px] text-faint">{clock(e.at)}</span>
                    {e.who && <span className="font-mono text-[10.5px] text-faint">by {e.who}</span>}
                    {e.service && (
                      <span className="font-mono text-[10.5px] text-mid">{e.service}</span>
                    )}
                    {e.ref && <span className="font-mono text-[10.5px] text-ink">{e.ref}</span>}
                    {e.source && (
                      <span className="ml-auto rounded-[3px] border border-line px-1.5 py-px font-mono text-[9px] tracking-wide text-faint">
                        via {e.source}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-[13.5px] font-medium text-ink">{e.title}</p>
                  {e.detail && (
                    <p className="mt-0.5 whitespace-pre-line text-[12.5px] leading-relaxed text-mid">
                      {e.detail}
                    </p>
                  )}
                  {e.link && (
                    <a
                      href={e.link.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-1.5 inline-flex items-center gap-1 font-mono text-[11px] hover:underline"
                      style={{ color: "var(--color-api)" }}
                    >
                      {e.link.label} <ArrowUpRight className="h-3 w-3" />
                    </a>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
