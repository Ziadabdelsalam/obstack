"use client";

import { useState } from "react";
import Link from "next/link";
import {
  Search,
  ChevronDown,
  Settings,
  Rocket,
  BookOpen,
  ScrollText,
  LogOut,
  UserRound,
} from "lucide-react";
import { NotificationsBell } from "./NotificationsPanel";
import { StartTourButton } from "./TourGuide";
import { Avatar } from "@/components/ui/Avatar";

/**
 * The signed-in operator and the workspace their session reads. Present in live
 * mode and null in mock mode, which has no session at all — the layout's guard
 * (D114) means a live shell never renders without one. `role` is the member
 * row's role in the organization the ACTIVE workspace belongs to (D717), and
 * `avatar` is `avatarPath` for a stored picture or null for the initials
 * (D718).
 */
export type Account = { name: string; email: string; workspaceId: string; role: string; avatar: string | null };

/** Two letters for the avatar, from the name the operator signed up with. */
function initials({ name, email }: Account): string {
  const letters = name
    .trim()
    .split(/\s+/)
    .map((word) => word[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("");
  return (letters || email.slice(0, 2)).toUpperCase();
}

/**
 * Sign-out is one of the two doors the auth mount leaves open (D120). The
 * endpoint only clears the cookie and answers JSON, so the landing is ours to
 * do — and it is deliberately a full document load rather than the router push
 * the lint rule below prefers: a push keeps the client alive, and everything it
 * is still holding was read for the workspace this click just left. Dropping
 * the document drops the router cache, the workspace provider and every
 * component that has rows in it, which is the only version of this that leaves
 * no tenant state behind.
 *
 * A POST that does not come back OK leaves the session alive, so it must not
 * land on /login: a page that says "signed out" over a live cookie is the one
 * lie this button can tell.
 */
function SignOutButton() {
  const [state, setState] = useState<"idle" | "busy" | "failed">("idle");
  const signOut = async () => {
    setState("busy");
    try {
      const res = await fetch("/api/auth/sign-out", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
        credentials: "same-origin",
      });
      if (!res.ok) throw new Error(`sign-out returned ${res.status}`);
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- see above: the point is to lose the client, not to keep it
      window.location.assign("/login");
    } catch {
      setState("failed");
    }
  };
  return (
    <>
      <button
        type="button"
        onClick={signOut}
        disabled={state === "busy"}
        className="flex w-full items-center gap-2.5 px-3.5 py-2 text-[12.5px] text-mid hover:bg-raised hover:text-ink disabled:opacity-70"
      >
        <LogOut className="h-3.5 w-3.5 text-faint" />
        {state === "busy" ? "Signing out…" : "Sign out"}
      </button>
      {state === "failed" && (
        <p role="alert" className="px-3.5 pb-2 text-[11.5px] leading-snug" style={{ color: "var(--color-err)" }}>
          Sign-out failed — you are still signed in. Try again.
        </p>
      )}
    </>
  );
}

function AccountMenu({ account }: { account: Account | null }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Account menu"
        className="flex items-center gap-1.5 rounded-md p-1 pl-1.5 transition-colors hover:bg-raised"
      >
        {account ? (
          <Avatar src={account.avatar} alt={account.name} initials={initials(account)} size={24} />
        ) : (
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-overlay font-mono text-[10px] text-mid">
            DO
          </span>
        )}
        <ChevronDown className="h-3 w-3 text-faint" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute top-full right-0 z-50 mt-1.5 w-[240px] overflow-hidden rounded-xl border border-line-strong bg-surface py-1 shadow-2xl">
            <div className="border-b border-line px-3.5 py-2.5">
              {/* Live mode names the real operator, and the role is not a
                  guess: it is the member row's role in the organization the
                  session's workspace belongs to (D717) — the org this account
                  owns by default, or the one it switched to.

                  Mock mode has no session and therefore no operator at all —
                  it used to borrow a real person's name and address and call
                  them the owner of an account nobody is signed into. The demo
                  now says what it is instead of naming somebody. */}
              <p className="text-[13px] font-medium text-ink">
                {account ? account.name : "Demo operator"}
              </p>
              <p className="font-mono text-[10.5px] text-faint">
                {account ? `${account.email} · ${account.role}` : "sample data · not signed in"}
              </p>
              {account && (
                <p className="mt-1.5 font-mono text-[10.5px] text-faint">
                  workspace {account.workspaceId}
                </p>
              )}
            </div>
            {[
              // The person, before the workspace (D707): the page behind this
              // entry changes the name and address the two lines above show,
              // and it is a real page in both images — the mock one says the
              // demo keeps no account, the live one holds the person's own row.
              { label: "Account", icon: UserRound, href: "/app/account" },
              { label: "Settings", icon: Settings, href: "/app/settings" },
              { label: "Quickstart", icon: Rocket, href: "/app/onboarding" },
              // There is no published documentation site to point at, so this
              // entry used to hold the empty fragment href — a menu item that
              // looks like a link and goes nowhere. It now opens the in-product
              // docs surface, which carries its own sample-data badge in live
              // mode.
              { label: "Docs", icon: BookOpen, href: "/app/docs" },
              { label: "Changelog", icon: ScrollText, href: "/changelog" },
            ].map(({ label, icon: Icon, href }) => (
              <Link
                key={label}
                href={href}
                onClick={() => setOpen(false)}
                className="flex items-center gap-2.5 px-3.5 py-2 text-[12.5px] text-mid hover:bg-raised hover:text-ink"
              >
                <Icon className="h-3.5 w-3.5 text-faint" />
                {label}
              </Link>
            ))}
            <div className="mt-1 border-t border-line pt-1">
              {account ? (
                <SignOutButton />
              ) : (
                <button
                  type="button"
                  title="Disabled in demo"
                  className="flex w-full cursor-not-allowed items-center gap-2.5 px-3.5 py-2 text-[12.5px] text-mid opacity-70"
                >
                  <LogOut className="h-3.5 w-3.5 text-faint" />
                  Sign out
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * The bar carries no system claims at all. It used to show an events-per-minute
 * throughput chip and a deployment-region chip in mock mode — both gated out of
 * live mode because neither has any backing there (D21/F6/F7). But a throughput
 * reading and a region are claims about the running system rather than demo
 * telemetry: obstack has no regions and the demo ingests nothing, so those two
 * chips were fiction about the product in the one strip of chrome a stranger
 * reads as status. The real ingest state lives on the overview, which measures
 * it. (The literals are not repeated here: `shell-honesty.test.ts` reads this
 * file and a quoted lie is still a hit.)
 *
 * `live` still reaches the bell, whose unread count is a claim about the
 * operator's own inbox (D21/F6/F7 again).
 */
export function TopBar({ live, account }: { live: boolean; account: Account | null }) {
  const openPalette = () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }));
  };

  return (
    <div className="flex h-11 shrink-0 items-center gap-3 border-b border-line bg-surface/60 px-4 backdrop-blur">
      <div className="ml-auto flex items-center gap-1.5">
        <button
          type="button"
          onClick={openPalette}
          className="flex items-center gap-2 rounded-md border border-line bg-raised py-1 pr-1.5 pl-2.5 text-[12px] text-faint transition-colors hover:border-line-strong hover:text-mid"
        >
          <Search className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Jump to…</span>
          <kbd className="rounded border border-line bg-surface px-1 font-mono text-[9.5px]">⌘K</kbd>
        </button>
        <StartTourButton />
        <NotificationsBell live={live} />
        <span className="mx-1 h-4 w-px bg-line" />
        <AccountMenu account={account} />
      </div>
    </div>
  );
}
