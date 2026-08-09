import { Suspense } from "react";
import { TraceDiff } from "@/components/trace/TraceDiff";

export default function TraceDiffPage() {
  return (
    <Suspense>
      <TraceDiff />
    </Suspense>
  );
}
