"use client";

import { ArrowRight, ShieldCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function AuthForm({ redirectTo }: { redirectTo: string }) {
  const router = useRouter();
  const [passcode, setPasscode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);
    setError(null);

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ passcode }),
      });

      if (!response.ok) {
        const payload = (await response.json()) as { error?: string };
        throw new Error(payload.error || "The passcode was incorrect.");
      }

      router.replace(redirectTo);
      router.refresh();
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Login failed.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top,_rgba(123,97,255,0.18),_transparent_32%),linear-gradient(180deg,_#090d16_0%,_#06080e_100%)] px-6 py-10 text-white">
      <div className="mx-auto flex min-h-[calc(100vh-5rem)] max-w-5xl items-center justify-center">
        <div className="grid w-full gap-8 overflow-hidden rounded-[32px] border border-white/10 bg-white/[0.04] shadow-[0_30px_120px_rgba(0,0,0,0.45)] backdrop-blur xl:grid-cols-[1.15fr_0.85fr]">
          <section className="border-b border-white/8 px-8 py-10 xl:border-b-0 xl:border-r">
            <div className="inline-flex items-center gap-2 rounded-full border border-cyan-400/30 bg-cyan-400/10 px-3 py-1 text-xs uppercase tracking-[0.28em] text-cyan-200">
              <ShieldCheck className="h-4 w-4" />
              Personal Workspace
            </div>
            <h1 className="mt-8 text-5xl font-semibold tracking-[-0.05em] text-white">
              Unlock MyMake
            </h1>
            <p className="mt-4 max-w-xl text-lg leading-8 text-slate-300">
              Upload a design zip, inspect the live preview, and let Claude rewrite your UI one
              element at a time. This deployment stays behind a single passcode and keeps every
              revision on the server.
            </p>
            <div className="mt-10 grid gap-4 text-sm text-slate-200/80">
              <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-4">
                Live preview is backed by a dedicated project runner for the active upload.
              </div>
              <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-4">
                Undo/redo and AI edits are stored as full project snapshots for safe rollback.
              </div>
              <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-4">
                Reference images and files are attached directly to each AI editing request.
              </div>
            </div>
          </section>

          <section className="px-8 py-10">
            <div className="mx-auto max-w-md">
              <h2 className="text-2xl font-semibold tracking-[-0.03em] text-white">
                Enter passcode
              </h2>
              <p className="mt-2 text-sm leading-7 text-slate-400">
                The passcode is configured via `APP_PASSCODE`.
              </p>

              <form className="mt-10 space-y-5" onSubmit={handleSubmit}>
                <label className="block">
                  <span className="mb-2 block text-xs font-medium uppercase tracking-[0.22em] text-slate-400">
                    Passcode
                  </span>
                  <input
                    autoFocus
                    className="w-full rounded-2xl border border-white/10 bg-black/30 px-5 py-4 text-base text-white outline-none transition focus:border-cyan-300/70 focus:bg-black/50"
                    type="password"
                    value={passcode}
                    onChange={(event) => setPasscode(event.target.value)}
                    placeholder="Your private MyMake passcode"
                  />
                </label>

                {error ? (
                  <p className="rounded-2xl border border-rose-400/30 bg-rose-400/10 px-4 py-3 text-sm text-rose-200">
                    {error}
                  </p>
                ) : null}

                <button
                  className="inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-[linear-gradient(135deg,_#3fb7ff,_#7c5cff)] px-5 py-4 text-sm font-semibold text-white shadow-[0_18px_50px_rgba(79,127,255,0.35)] transition hover:translate-y-[-1px] disabled:cursor-not-allowed disabled:opacity-60"
                  type="submit"
                  disabled={isSubmitting}
                >
                  {isSubmitting ? "Unlocking..." : "Enter Studio"}
                  <ArrowRight className="h-4 w-4" />
                </button>
              </form>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
