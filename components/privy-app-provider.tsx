"use client";

import { PrivyProvider } from "@privy-io/react-auth";
import type { ReactNode } from "react";

export function PrivyAppProvider({
  appId,
  children,
}: {
  appId: string;
  children: ReactNode;
}) {
  const trimmedAppId = appId.trim();
  const hasValidAppId = Boolean(trimmedAppId && trimmedAppId !== "missing-privy-app-id");

  if (!hasValidAppId) {
    return (
      <div className="min-h-screen bg-[linear-gradient(180deg,_#090d16_0%,_#06080e_100%)] px-6 py-10 text-white">
        <div className="mx-auto flex min-h-[calc(100vh-5rem)] max-w-3xl items-center justify-center">
          <div className="rounded-[28px] border border-amber-300/20 bg-amber-300/10 p-8 text-center shadow-[0_30px_120px_rgba(0,0,0,0.45)]">
            <p className="text-sm font-medium uppercase tracking-[0.24em] text-amber-200">
              Privy Config Required
            </p>
            <h1 className="mt-4 text-3xl font-semibold tracking-[-0.04em] text-white">
              MyMake auth is not configured yet
            </h1>
            <p className="mt-4 text-sm leading-7 text-slate-200/80">
              Add `NEXT_PUBLIC_PRIVY_APP_ID` and `PRIVY_APP_SECRET` to this environment to enable
              user accounts, personal project ownership, and GitHub connections.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <PrivyProvider
      appId={trimmedAppId}
      config={{
        appearance: {
          theme: "dark",
          accentColor: "#6c63ff",
        },
      }}
    >
      {children}
    </PrivyProvider>
  );
}
