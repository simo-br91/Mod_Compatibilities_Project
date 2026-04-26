"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { fetchSession } from "@/lib/api";
import { clearSession, loadSession, saveSession } from "@/lib/session";
import type { SessionResponse } from "@modcompat/api-contracts";

export default function DashboardPage() {
  const router = useRouter();
  const [session, setSession] = useState<SessionResponse | null>(() => loadSession());

  useEffect(() => {
    let cancelled = false;

    async function init() {
      try {
        const fetchedSession = await fetchSession();
        if (cancelled) return;
        saveSession(fetchedSession);
        setSession(fetchedSession);
      } catch {
        clearSession();
        if (!cancelled) setSession(null);
      }
    }

    void init();
    return () => { cancelled = true; };
  }, [router]);

  if (!session) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
        <div className="mc-info-box text-center">
          <p className="font-minecraft text-xl text-mc-text-muted tracking-wide">⚠ NOT SIGNED IN</p>
          <p className="text-base text-mc-text-muted mt-2">
            You are in guest mode. Sign in to access your projects and saved analyses.
          </p>
          <div className="mt-4">
            <Link href="/sign-in" className="mc-btn-primary inline-block px-6 py-2 text-xl font-minecraft">
              ▶ Sign In
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
      <h1 className="font-minecraft text-3xl text-mc-green tracking-wider mb-1">DASHBOARD</h1>
      <p className="text-mc-text-muted text-lg mb-8">
        Welcome back, {session.user.displayName}. Select a project to start.
      </p>

      {session.projects.length === 0 ? (
        <div className="mc-panel text-center">
          <p className="font-minecraft text-mc-text-muted text-xl tracking-wide">NO PROJECTS YET</p>
          <p className="text-base text-mc-text-dim mt-2">
            Create one from the gateway or workspace service.
          </p>
        </div>
      ) : (
        <div className="grid gap-3">
          {session.projects.map((project) => (
            <Link
              key={project.projectId}
              href={`/projects/${project.projectId}/imports`}
              className="mc-panel flex items-center justify-between hover:border-mc-green transition-colors group"
            >
              <div>
                <p className="font-minecraft text-xl text-mc-text tracking-wide group-hover:text-mc-green">
                  {project.name}
                </p>
                <p className="text-base text-mc-text-dim mt-0.5">{project.slug}</p>
              </div>
              <span className="font-minecraft text-mc-text-muted text-xl group-hover:text-mc-green">▶</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
