import { DocsLibrary } from "@/components/docs/DocsLibrary";

export default function DocsPage() {
  return (
    <div className="mx-auto max-w-5xl px-5 py-4">
      <div className="mb-1 flex items-center justify-between">
        <h1 className="font-display text-[19px] font-semibold text-ink">Docs</h1>
        <span className="font-mono text-[11px] text-faint">
          deployment guides · runbooks · DR — the infra manual, next to the telemetry
        </span>
      </div>
      <p className="mb-5 text-[12.5px] text-mid">
        Loopwork&apos;s authored infrastructure documentation, hosted where the incidents happen.
        Runbooks link straight into the live pages they reference.
      </p>
      <DocsLibrary />
    </div>
  );
}
