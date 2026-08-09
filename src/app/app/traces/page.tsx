import { Suspense } from "react";
import { TracesSearch } from "@/components/traces/TracesSearch";

export default function TracesPage() {
  return (
    <Suspense>
      <TracesSearch />
    </Suspense>
  );
}
