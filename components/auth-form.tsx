"use client";

import { ArrowRight, ShieldCheck } from "lucide-react";
import { getAccessToken, getIdentityToken, usePrivy } from "@privy-io/react-auth";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

export function AuthForm({ redirectTo }: { redirectTo: string }) {
  const router = useRouter();
  const { ready, authenticated, user, login } = usePrivy();
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const attemptedSessionSyncRef = useRef(false);

  const exchangePrivySession = useCallback(async () => {
    setIsSubmitting(true);
    setError(null);

    try {
      const [accessToken, identityToken] = await Promise.all([
        getAccessToken(),
        getIdentityToken(),
      ]);

      if (!accessToken || !identityToken) {
        throw new Error("Privy did not return a valid session yet. Please try again.");
      }

      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ accessToken, identityToken }),
      });

      if (!response.ok) {
        const payload = (await response.json()) as { error?: string };
        throw new Error(payload.error || "Could not start your MyMake session.");
      }

      router.replace(redirectTo);
      router.refresh();
    } catch (caughtError) {
      attemptedSessionSyncRef.current = false;
      setError(caughtError instanceof Error ? caughtError.message : "Login failed.");
    } finally {
      setIsSubmitting(false);
    }
  }, [redirectTo, router]);

  useEffect(() => {
    if (!ready || !authenticated || attemptedSessionSyncRef.current || isSubmitting) {
      return;
    }

    attemptedSessionSyncRef.current = true;
    void exchangePrivySession();
  }, [authenticated, exchangePrivySession, isSubmitting, ready]);

  function handleEnterStudio() {
    setError(null);

    if (!ready) {
      return;
    }

    if (authenticated) {
      attemptedSessionSyncRef.current = true;
      void exchangePrivySession();
      return;
    }

    login();
  }

  const signedInLabel =
    user?.linkedAccounts?.find(
      (account) =>
        (account.type === "email" && "address" in account && typeof account.address === "string") ||
        ("email" in account && typeof account.email === "string") ||
        ("username" in account && typeof account.username === "string"),
    );

  const signedInIdentity =
    (signedInLabel &&
      ("address" in signedInLabel && typeof signedInLabel.address === "string"
        ? signedInLabel.address
        : "email" in signedInLabel && typeof signedInLabel.email === "string"
          ? signedInLabel.email
          : "username" in signedInLabel && typeof signedInLabel.username === "string"
            ? signedInLabel.username
            : null)) ||
    "your Privy account";

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top,_rgba(123,97,255,0.18),_transparent_32%),linear-gradient(180deg,_#090d16_0%,_#06080e_100%)] px-6 py-10 text-white">
      <div className="mx-auto flex min-h-[calc(100vh-5rem)] max-w-5xl items-center justify-center">
        <div className="grid w-full gap-8 overflow-hidden rounded-[32px] border border-white/10 bg-white/[0.04] shadow-[0_30px_120px_rgba(0,0,0,0.45)] backdrop-blur xl:grid-cols-[1.15fr_0.85fr]">
          <section className="border-b border-white/8 px-8 py-10 xl:border-b-0 xl:border-r">
            <div className="inline-flex items-center gap-2 rounded-full border border-cyan-400/30 bg-cyan-400/10 px-3 py-1 text-xs uppercase tracking-[0.28em] text-cyan-200">
              <ShieldCheck className="h-4 w-4" />
              Privy Workspace
            </div>
            <h1 className="mt-8 text-5xl font-semibold tracking-[-0.05em] text-white">
              Sign in to MyMake
            </h1>
            <p className="mt-4 max-w-xl text-lg leading-8 text-slate-300">
              Each user gets their own projects, revision history, attachments, preview state, and
              GitHub connection. Your uploaded work stays scoped to your authenticated account.
            </p>
            <div className="mt-10 grid gap-4 text-sm text-slate-200/80">
              <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-4">
                Live preview is backed by a dedicated project runner for the active upload.
              </div>
              <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-4">
                Checkpoints, AI edits, files, and attachments are now stored per Privy user.
              </div>
              <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-4">
                GitHub repo sync can now be tied to each user instead of a single shared session.
              </div>
            </div>
          </section>

          <section className="px-8 py-10">
            <div className="mx-auto max-w-md">
              <h2 className="text-2xl font-semibold tracking-[-0.03em] text-white">
                Continue with Privy
              </h2>
              <p className="mt-2 text-sm leading-7 text-slate-400">
                Use your email or any enabled Privy login method to open your personal MyMake
                workspace.
              </p>

              {user ? (
                <div className="mt-8 rounded-2xl border border-white/8 bg-white/[0.03] px-4 py-4 text-sm text-slate-200">
                  Signed in as{" "}
                  <span className="font-medium text-white">{signedInIdentity}</span>
                </div>
              ) : null}

              {error ? (
                <p className="mt-6 rounded-2xl border border-rose-400/30 bg-rose-400/10 px-4 py-3 text-sm text-rose-200">
                  {error}
                </p>
              ) : null}

              <button
                className="mt-10 inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-[linear-gradient(135deg,_#3fb7ff,_#7c5cff)] px-5 py-4 text-sm font-semibold text-white shadow-[0_18px_50px_rgba(79,127,255,0.35)] transition hover:translate-y-[-1px] disabled:cursor-not-allowed disabled:opacity-60"
                type="button"
                disabled={!ready || isSubmitting}
                onClick={handleEnterStudio}
              >
                {isSubmitting
                  ? "Opening your workspace..."
                  : authenticated
                    ? "Continue to workspace"
                    : "Sign in with Privy"}
                <ArrowRight className="h-4 w-4" />
              </button>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
