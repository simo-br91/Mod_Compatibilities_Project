"use client";

import type { SessionResponse } from "@modcompat/api-contracts";

const SESSION_KEY = "modcompat_session";

export function saveSession(session: SessionResponse) {
  if (typeof sessionStorage !== "undefined") {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  }
}

export function loadSession(): SessionResponse | null {
  if (typeof sessionStorage === "undefined") return null;
  const raw = sessionStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SessionResponse;
  } catch {
    return null;
  }
}

export function clearSession() {
  if (typeof sessionStorage !== "undefined") {
    sessionStorage.removeItem(SESSION_KEY);
  }
}

export function getCurrentActorId(): string | null {
  return loadSession()?.user.userId ?? null;
}

const GUEST_ACTOR_KEY = "modcompat_guest_actor_id";

export function getOrCreateGuestActorId(): string {
  if (typeof sessionStorage === "undefined") return "guest-anonymous";
  let id = sessionStorage.getItem(GUEST_ACTOR_KEY);
  if (!id) {
    id = `guest-${Math.random().toString(36).slice(2, 10)}`;
    sessionStorage.setItem(GUEST_ACTOR_KEY, id);
  }
  return id;
}

export function getEffectiveActorId(): string {
  return getCurrentActorId() ?? getOrCreateGuestActorId();
}

export function getCurrentMembershipRole():
  | SessionResponse["memberships"][number]["role"]
  | null {
  return loadSession()?.memberships?.[0]?.role ?? null;
}

export function canAccessAdminFeatures(): boolean {
  const role = getCurrentMembershipRole();
  return role === "owner" || role === "admin";
}

/** Return the first project ID from the saved session, or null. */
export function getDefaultProjectId(): string | null {
  const session = loadSession();
  return session?.projects?.[0]?.projectId ?? null;
}

/** Return the first workspace ID from the saved session, or null. */
export function getDefaultWorkspaceId(): string | null {
  const session = loadSession();
  return session?.workspaces?.[0]?.workspaceId ?? null;
}

// ---------------------------------------------------------------------------
// Recent analyses — tracked in sessionStorage so users can revisit analyses
// ---------------------------------------------------------------------------

const RECENT_ANALYSES_KEY = "modcompat_recent_analyses";

export interface RecentAnalysis {
  analysisId: string;
  projectId: string;
  createdAt: string;
  /** Optional human-readable label (e.g. mod count or loader). */
  label?: string;
}

export function saveRecentAnalysis(entry: RecentAnalysis) {
  if (typeof sessionStorage === "undefined") return;
  const existing = loadRecentAnalyses();
  const deduped = existing.filter((a) => a.analysisId !== entry.analysisId);
  const updated = [entry, ...deduped].slice(0, 20);
  sessionStorage.setItem(RECENT_ANALYSES_KEY, JSON.stringify(updated));
}

export function loadRecentAnalyses(): RecentAnalysis[] {
  if (typeof sessionStorage === "undefined") return [];
  const raw = sessionStorage.getItem(RECENT_ANALYSES_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as RecentAnalysis[];
  } catch {
    return [];
  }
}

export function clearRecentAnalyses() {
  if (typeof sessionStorage !== "undefined") {
    sessionStorage.removeItem(RECENT_ANALYSES_KEY);
  }
}
