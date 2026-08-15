/**
 * The per-element honesty marker (D21, extended by F6/F7): in live mode a
 * surface that still renders demo content says so, in the sample-data badge's
 * visual language. `title` carries the reason, which differs per call site.
 * Delete the call as each surface is wired to real data.
 */
export function SampleMark({ title }: { title: string }) {
  return (
    <span
      title={title}
      className="rounded border px-1.5 py-px font-mono text-[9.5px] tracking-wide"
      style={{
        borderColor: "color-mix(in srgb, var(--color-warn) 30%, var(--color-line))",
        background: "color-mix(in srgb, var(--color-warn) 6%, transparent)",
        color: "var(--color-warn)",
      }}
    >
      SAMPLE
    </span>
  );
}
