"use client";

import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

const GATEWAY_URL =
  typeof window !== "undefined"
    ? (process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:8080")
    : (process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:8080");

function SignInForm() {
  const searchParams = useSearchParams();
  const [redirecting, setRedirecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const errorParam = searchParams.get("error");
    if (errorParam) {
      setError(decodeURIComponent(errorParam));
    }
  }, [searchParams]);

  function handleSignIn() {
    setRedirecting(true);
    setError(null);
    const redirectTo = encodeURIComponent(`${window.location.origin}/dashboard`);
    window.location.href = `${GATEWAY_URL}/auth/login?redirectTo=${redirectTo}`;
  }

  return (
    <div className="mc-panel space-y-5 max-w-md w-full">
      {error && (
        <div className="mc-error-box">
          <p className="text-mc-danger font-minecraft text-lg">⛔ Sign-in Error</p>
          <p className="text-base mt-1">{error}</p>
        </div>
      )}

      {redirecting ? (
        <div className="flex flex-col items-center gap-3 py-6">
          <svg className="h-8 w-8 animate-spin text-mc-green" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
          </svg>
          <p className="font-minecraft text-mc-text-muted text-lg tracking-wide">
            REDIRECTING...
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="mc-panel-inner text-base text-mc-text-muted space-y-1">
            <p>Sign in through your configured OAuth / OIDC provider.</p>
            <p className="text-sm text-mc-text-dim">
              Gateway:{" "}
              <code className="bg-mc-stone-dark px-1 text-mc-green text-sm">{GATEWAY_URL}</code>
            </p>
          </div>

          <button
            type="button"
            onClick={handleSignIn}
            className="mc-btn-primary w-full text-2xl py-3 tracking-widest font-minecraft"
          >
            ▶ SIGN IN
          </button>

          <div className="mc-divider" />

          <div className="text-center">
            <Link
              href="/"
              className="font-minecraft text-mc-text-muted text-lg hover:text-mc-text tracking-wide"
            >
              ← Continue without account
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

export default function SignInPage() {
  return (
    <div className="min-h-screen bg-mc-bg flex flex-col">
      {/* Header */}
      <header className="border-b-2 border-mc-border bg-mc-panel">
        <div className="mx-auto max-w-4xl px-4 py-3 flex items-center gap-3">
          <span className="text-3xl" aria-hidden>⛏</span>
          <Link href="/" className="font-minecraft text-2xl text-mc-green tracking-widest text-shadow-mc">
            MODPACK CHECKER
          </Link>
        </div>
      </header>

      <div className="flex-1 flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-4xl grid gap-10 lg:grid-cols-2 items-center">

          {/* Left: info */}
          <div className="space-y-6">
            <div>
              <h1 className="font-minecraft text-3xl text-mc-green tracking-wider">
                SIGN IN
              </h1>
              <p className="text-mc-text-muted text-lg mt-2">
                Save your mod analyses and access them across sessions.
              </p>
            </div>

            <div className="space-y-3">
              <div className="mc-panel-inner">
                <p className="font-minecraft text-mc-gold text-lg">💾 SAVE ANALYSES</p>
                <p className="text-base text-mc-text-muted mt-1">
                  Your compatibility reports are saved permanently and accessible any time.
                </p>
              </div>
              <div className="mc-panel-inner">
                <p className="font-minecraft text-mc-gold text-lg">🔒 SECURE SESSION</p>
                <p className="text-base text-mc-text-muted mt-1">
                  Login via your configured OIDC provider. The gateway manages sessions via
                  HttpOnly cookies — no credentials stored locally.
                </p>
              </div>
            </div>

            <div className="mc-info-box text-base text-mc-text-muted">
              Don&apos;t want an account?{" "}
              <Link href="/" className="text-mc-green hover:underline font-minecraft">
                Use as guest →
              </Link>{" "}
              (data cleared when tab closes)
            </div>
          </div>

          {/* Right: form */}
          <div className="flex justify-center lg:justify-end">
            <Suspense
              fallback={
                <div className="mc-panel max-w-md w-full">
                  <div className="h-12 animate-pulse bg-mc-stone-dark" />
                </div>
              }
            >
              <SignInForm />
            </Suspense>
          </div>
        </div>
      </div>
    </div>
  );
}
