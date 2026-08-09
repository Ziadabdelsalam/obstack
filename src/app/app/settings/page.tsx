const rows = [
  { k: "workspace", v: "Loopwork · loopwork-prod" },
  { k: "api key", v: "ob_live_9f2e…c41a" },
  { k: "plan", v: "Free — 50k events/mo · 7-day retention" },
  { k: "members", v: "3 of unlimited" },
  { k: "data region", v: "eu-central" },
];

export default function SettingsPage() {
  return (
    <div className="mx-auto max-w-2xl px-5 py-8">
      <h1 className="font-display text-[19px] font-semibold text-ink">Settings</h1>
      <div className="mt-4 rounded-lg border border-line bg-surface">
        {rows.map((r) => (
          <div
            key={r.k}
            className="flex items-center justify-between border-b border-line/60 px-4 py-3 last:border-0"
          >
            <span className="font-mono text-[11px] uppercase tracking-widest text-faint">
              {r.k}
            </span>
            <span className="font-mono text-[12.5px] text-mid">{r.v}</span>
          </div>
        ))}
      </div>
      <p className="mt-3 text-[12px] text-faint">
        Billing, members and retention settings arrive with the product shell phase.
      </p>
    </div>
  );
}
