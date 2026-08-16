"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowUpRight, Info, TriangleAlert } from "lucide-react";
import { docArticles, docSections, type DocBlock } from "@/mock/docs";

function Block({ block }: { block: DocBlock }) {
  switch (block.kind) {
    case "p":
      return <p className="text-[13px] leading-relaxed text-mid">{block.text}</p>;
    case "steps":
      return (
        <ol className="flex flex-col gap-1.5">
          {block.items.map((item, i) => (
            <li key={i} className="flex gap-2.5 text-[13px] leading-relaxed text-mid">
              <span className="mt-px shrink-0 font-mono text-[11px] text-faint">{i + 1}.</span>
              {item}
            </li>
          ))}
        </ol>
      );
    case "code":
      return (
        <pre className="overflow-x-auto rounded-md border border-line bg-raised p-3 font-mono text-[11.5px] leading-relaxed text-ink">
          {block.code}
        </pre>
      );
    case "callout": {
      const warn = block.tone === "warn";
      const color = warn ? "var(--color-warn)" : "var(--color-api)";
      const Icon = warn ? TriangleAlert : Info;
      return (
        <div
          className="flex gap-2.5 rounded-md border p-3 text-[12.5px] leading-relaxed text-mid"
          style={{
            borderColor: `color-mix(in srgb, ${color} 35%, var(--color-line))`,
            background: `color-mix(in srgb, ${color} 6%, transparent)`,
          }}
        >
          <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" style={{ color }} />
          {block.text}
        </div>
      );
    }
    case "link":
      return (
        <Link
          href={block.href}
          className="inline-flex items-center gap-1 font-mono text-[11px] hover:underline"
          style={{ color: "var(--color-api)" }}
        >
          {block.label} <ArrowUpRight className="h-3 w-3" />
        </Link>
      );
  }
}

export function DocsLibrary() {
  const [slug, setSlug] = useState(docArticles[0].slug);
  const doc = docArticles.find((d) => d.slug === slug) ?? docArticles[0];

  return (
    <div className="flex gap-8">
      <nav className="sticky top-4 w-[220px] shrink-0 self-start">
        {docSections.map((sec) => (
          <div key={sec.id} className="mb-4">
            <p className="mb-1 px-2 font-mono text-[9.5px] uppercase tracking-widest text-faint">
              {sec.label}
            </p>
            <div className="flex flex-col gap-px">
              {docArticles
                .filter((d) => d.section === sec.id)
                .map((d) => (
                  <button
                    key={d.slug}
                    type="button"
                    onClick={() => setSlug(d.slug)}
                    className={`rounded-md px-2 py-[5px] text-left text-[12.5px] transition-colors ${
                      d.slug === slug
                        ? "bg-overlay text-ink"
                        : "text-mid hover:bg-raised hover:text-ink"
                    }`}
                  >
                    {d.title}
                  </button>
                ))}
            </div>
          </div>
        ))}
      </nav>

      <article className="min-w-0 max-w-[720px] flex-1 pb-8">
        <h2 className="font-display text-[17px] font-semibold text-ink">{doc.title}</h2>
        <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <span className="font-mono text-[10.5px] text-faint">owner {doc.owner}</span>
          <span className="font-mono text-[10.5px] text-faint">updated {doc.updated}</span>
          {doc.tags.map((t) => (
            <span
              key={t}
              className="rounded-[3px] bg-raised px-1.5 py-px font-mono text-[9.5px] tracking-wide text-mid"
            >
              {t}
            </span>
          ))}
        </div>
        <p className="mt-2 text-[13px] leading-relaxed text-mid">{doc.summary}</p>
        <div className="mt-4 flex flex-col gap-3.5 border-t border-line pt-4">
          {doc.blocks.map((block, i) => (
            <Block key={i} block={block} />
          ))}
        </div>
      </article>
    </div>
  );
}
