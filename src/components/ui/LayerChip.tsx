import { layerColor, layerLabel } from "@/lib/layers";
import type { Layer } from "@/lib/types";

export function LayerChip({ layer }: { layer: Layer }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-[3px] border px-1 py-px font-mono text-[10px] leading-4 tracking-wide"
      style={{
        color: layerColor[layer],
        borderColor: `color-mix(in srgb, ${layerColor[layer]} 35%, transparent)`,
        background: `color-mix(in srgb, ${layerColor[layer]} 10%, transparent)`,
      }}
    >
      {layerLabel[layer]}
    </span>
  );
}

export function LayerDot({ layer }: { layer: Layer }) {
  return (
    <span
      className="inline-block h-1.5 w-1.5 rounded-full"
      style={{ background: layerColor[layer] }}
    />
  );
}
