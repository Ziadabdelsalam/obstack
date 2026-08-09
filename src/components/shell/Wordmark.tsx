import { layerOrder, layerColor } from "@/lib/layers";

export function Wordmark({ size = "sm" }: { size?: "sm" | "lg" }) {
  return (
    <span
      className={`inline-flex items-baseline gap-1.5 font-mono font-semibold tracking-tight ${
        size === "lg" ? "text-xl" : "text-[15px]"
      }`}
    >
      <span className="flex items-center gap-[3px] self-center">
        {layerOrder.map((l) => (
          <span
            key={l}
            className={size === "lg" ? "h-3 w-[3px]" : "h-2.5 w-[2.5px]"}
            style={{ background: layerColor[l], borderRadius: 1 }}
          />
        ))}
      </span>
      <span className="text-ink">obstack</span>
    </span>
  );
}
