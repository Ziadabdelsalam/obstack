export function StatusPill({ status }: { status: "ok" | "error" }) {
  const ok = status === "ok";
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-[3px] px-1.5 py-px font-mono text-[10px] tracking-wide"
      style={{
        color: ok ? "var(--color-ok)" : "var(--color-err)",
        background: `color-mix(in srgb, ${ok ? "var(--color-ok)" : "var(--color-err)"} 12%, transparent)`,
      }}
    >
      <span
        className="h-1 w-1 rounded-full"
        style={{ background: "currentColor" }}
      />
      {ok ? "OK" : "ERROR"}
    </span>
  );
}
