/**
 * The per-surface honesty label for the landing page's fabricated content
 * (D326/K9) — the marketing-side counterpart of the app shell's `DemoFooter`
 * and `SampleDataBadge`, in the same small mono voice.
 *
 * It renders words rather than owning them: each caller composes its own
 * sentence around `SAMPLE_COPY`, because what a reader needs to be told differs
 * per surface (a scripted video is not a screenshot of a running demo). The
 * shared half is the constant; the specific half is the caller's.
 *
 * No hooks, no `"use client"`: usable from the Server Component landing page
 * and from the two `"use client"` marketing components alike.
 */
export function SampleLabel({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <p className={`font-mono text-[11px] leading-relaxed text-faint ${className}`.trim()}>
      {children}
    </p>
  );
}
