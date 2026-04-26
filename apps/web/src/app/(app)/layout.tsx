"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { beginLogout, fetchSession } from "@/lib/api";
import {
  canAccessAdminFeatures,
  clearRecentAnalyses,
  clearSession,
  loadSession,
  saveSession
} from "@/lib/session";
import { cn } from "@/lib/utils";
import type { SessionResponse } from "@modcompat/api-contracts";

interface NavLink {
  label: string;
  href: string;
}

function NavItems({
  links,
  pathname,
  onNavigate
}: {
  links: NavLink[];
  pathname: string;
  onNavigate?: () => void;
}) {
  return (
    <nav className="flex flex-col gap-1">
      {links.map((link) => {
        const active = pathname === link.href || pathname.startsWith(`${link.href}/`);
        return (
          <Link
            key={link.href}
            href={link.href}
            onClick={onNavigate}
            className={cn(
              "px-3 py-2 font-minecraft text-lg tracking-wide transition-colors border-2",
              active
                ? "border-mc-green bg-mc-green text-white"
                : "border-transparent text-mc-text-muted hover:border-mc-stone-dark hover:text-mc-text hover:bg-mc-stone-dark"
            )}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [session, setSession] = useState<SessionResponse | null>(() => loadSession());
  const [isHydrating, setIsHydrating] = useState(true);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function hydrateSession() {
      try {
        const fetchedSession = await fetchSession();
        if (cancelled) return;
        saveSession(fetchedSession);
        setSession(fetchedSession);
      } catch {
        // Not signed in — continue as guest, don't redirect
        clearSession();
        if (!cancelled) setSession(null);
      } finally {
        if (!cancelled) setIsHydrating(false);
      }
    }

    void hydrateSession();
    return () => { cancelled = true; };
  }, [router]);

  useEffect(() => {
    setMobileNavOpen(false);
  }, [pathname]);

  function handleSignOut() {
    clearSession();
    clearRecentAnalyses();
    beginLogout(`${window.location.origin}/sign-in`);
  }

  const projectId = session?.projects?.[0]?.projectId;

  const navLinks = useMemo(
    () => [
      { label: "⛏ Home", href: "/" },
      ...(session && projectId
        ? [
            { label: "Dashboard", href: "/dashboard" },
            { label: "Import Pack", href: `/projects/${projectId}/imports` },
            { label: "Analyses", href: `/projects/${projectId}/analyses` },
          ]
        : []),
      ...(session && canAccessAdminFeatures()
        ? [{ label: "Admin", href: "/admin/curations" }]
        : []),
    ],
    [projectId, session]
  );

  if (isHydrating) {
    return (
      <div className="min-h-screen bg-mc-bg flex items-center justify-center">
        <p className="font-minecraft text-mc-text-muted text-xl animate-pulse tracking-widest">
          LOADING...
        </p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-mc-bg text-mc-text lg:flex">
      {/* Guest banner */}
      {!session && (
        <div className="fixed top-0 left-0 right-0 z-50 bg-mc-stone-dark border-b-2 border-mc-border px-4 py-2 flex items-center justify-between">
          <p className="font-minecraft text-base text-mc-text-muted tracking-wide">
            ⚠ GUEST MODE — data will be lost when you close this tab.
          </p>
          <Link href="/sign-in" className="mc-btn text-sm px-3 py-1">
            Sign In to Save
          </Link>
        </div>
      )}

      {/* Mobile header */}
      <header className={cn(
        "sticky z-30 border-b-2 border-mc-border bg-mc-panel lg:hidden",
        !session ? "top-10" : "top-0"
      )}>
        <div className="flex items-center justify-between px-4 py-3">
          <Link href="/" className="font-minecraft text-xl text-mc-green tracking-widest text-shadow-mc">
            ⛏ MODPACK CHECKER
          </Link>
          <button
            type="button"
            onClick={() => setMobileNavOpen((open) => !open)}
            className="mc-btn w-10 h-10 flex items-center justify-center p-0"
            aria-label={mobileNavOpen ? "Close navigation" : "Open navigation"}
          >
            {mobileNavOpen ? "✕" : "☰"}
          </button>
        </div>
      </header>

      {mobileNavOpen && (
        <button
          type="button"
          aria-label="Close navigation overlay"
          className="fixed inset-0 z-20 bg-black/60 lg:hidden"
          onClick={() => setMobileNavOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-30 flex w-[280px] max-w-[85vw] flex-col border-r-2 border-mc-border bg-mc-panel transition-transform duration-200 lg:static lg:w-[var(--sidebar-width)] lg:max-w-none lg:translate-x-0",
          !session ? "top-10 lg:top-0" : "",
          mobileNavOpen ? "translate-x-0" : "-translate-x-full"
        )}
      >
        <div className="border-b-2 border-mc-stone-dark px-4 py-4">
          <Link href="/" className="font-minecraft text-xl text-mc-green tracking-widest text-shadow-mc">
            ⛏ MODPACK CHECKER
          </Link>
          {session?.organization && (
            <p className="mt-1 text-base text-mc-text-muted truncate">{session.organization.name}</p>
          )}
        </div>

        <div className="flex-1 overflow-y-auto px-3 py-4">
          <NavItems links={navLinks} pathname={pathname} onNavigate={() => setMobileNavOpen(false)} />
        </div>

        <div className="border-t-2 border-mc-stone-dark px-4 py-4">
          {session?.user ? (
            <>
              <p className="font-minecraft text-base text-mc-text truncate tracking-wide">{session.user.displayName}</p>
              <p className="text-sm text-mc-text-muted mb-3 truncate">{session.user.email}</p>
              <button
                onClick={handleSignOut}
                className="mc-btn w-full text-base"
              >
                Sign Out
              </button>
            </>
          ) : (
            <Link href="/sign-in" className="mc-btn w-full text-center text-base block">
              Sign In
            </Link>
          )}
        </div>
      </aside>

      <main className={cn("min-w-0 flex-1 overflow-x-hidden", !session ? "pt-10 lg:pt-0" : "")}>
        {children}
      </main>
    </div>
  );
}
