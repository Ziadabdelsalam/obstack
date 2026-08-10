# Plan: /app/docs — Infrastructure Docs & Runbooks (frontend mock only)

**Status:** approved design, awaiting final go-ahead
**Constraint (explicit from Ziad):** mock-up in the frontend only. No real service, no API routes, no persistence, no editing. All content is hardcoded mock data, same as every other page in this demo app.

## What we're building

A new in-app page at `/app/docs`: a curated, authored library of Loopwork's
infrastructure documentation — deployment guides, environment topology, incident
runbooks, disaster recovery — hosted inside obstack next to the telemetry it
documents. Two-pane reading layout in the existing dark shell.

## Files to create / touch

1. **`src/mock/docs.ts`** (new)
   - Types: `DocSection { id, label }`, `DocArticle { slug, section, title, summary, owner, updated, tags[], blocks[] }`
   - `DocBlock` union: `{ kind: "p", text }` · `{ kind: "steps", items[] }` ·
     `{ kind: "code", lang, code }` · `{ kind: "callout", tone: "info"|"warn", text }` ·
     `{ kind: "link", label, href }` (href = internal app route)
   - 4 sections, ~10 authored docs in Loopwork's voice, consistent with existing
     mock data (services: gateway/agent-worker/tools/notifier, kafka, prod-eu-central,
     agent-worker OOM-kills, LLM provider = OpenRouter/Vercel AI Gateway):
     - Deployment: "Deploy pipeline & rollback", "Collector rollout (DaemonSet)"
     - Environments: "prod-eu-central topology", "Staging & preview environments"
     - Runbooks: "agent-worker OOM-kill", "Kafka consumer lag", "LLM provider degradation", "Pod crash-loop triage"
     - Disaster Recovery: "Backup & restore", "Region failover"

2. **`src/components/docs/DocsLibrary.tsx`** (new, `"use client"`)
   - Local `useState` for selected doc slug (default: first doc). No routing per doc.
   - Left rail (sticky, ~240px): section labels (small uppercase tracked, like
     SideNav group labels) with doc titles beneath; active doc highlighted.
   - Reading pane (max-w ~720px): h1 title, meta row (owner · updated · tag pills),
     rendered blocks. Code blocks in mono on panel background; callouts tinted
     with existing `--color-warn` / `--color-api` tokens; `link` blocks render as
     Next `<Link>` with ArrowUpRight icon to live pages (/app/traces, /app/infra,
     /app/alerts).
   - Follow styling idioms from `src/app/app/changes/page.tsx` and the settings
     suite (font-display headings, text-ink/text-faint, font-mono meta).

3. **`src/app/app/docs/page.tsx`** (new) — thin server wrapper: page header
   ("Docs" + subtitle "deployment guides · runbooks · DR — the infra manual, next
   to the telemetry") rendering `<DocsLibrary />`.

4. **`src/components/shell/SideNav.tsx`** — add `{ href: "/app/docs", label: "Docs", icon: BookOpen }`
   immediately after the Infrastructure entry (line ~47).

5. **`src/components/shell/CommandPalette.tsx`** — add `{ label: "Docs", hint: "page", href: "/app/docs" }`
   next to the Infrastructure entry (line ~25).

## Explicitly out of scope

Editing UI, doc search, markdown parsing, per-doc URLs/deep links, any backend.

## Verification

- `npm run build` passes clean.
- Visual check via Playwright on the running dev server (port 3199): navigate to
  /app/docs, confirm rail + reader render, click a second doc.
- Screenshot `24-infra-docs.png` (1440px, full page) added to
  `pitchdeck-assets/screenshots/`, plus a new row in `pitchdeck-assets/PROMPT.md`
  feature table.
