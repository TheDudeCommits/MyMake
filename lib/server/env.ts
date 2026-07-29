import path from "node:path";

import { resolveInsideRoot } from "@/lib/server/path-utils";

interface EnvConfig {
  anthropicApiKey?: string;
  githubClientId?: string;
  githubClientSecret?: string;
  openaiApiKey?: string;
  privyAppId?: string;
  privyAppSecret?: string;
  publicPrivyAppId?: string;
  primaryOwnerEmail: string;
  appPasscode: string;
  appBaseUrl?: string;
  databasePath: string;
  port: number;
  storageRoot: string;
  maxRevisionCount: number;
}

let cachedEnv: EnvConfig | null = null;

function normalizeConfiguredPath(value: string, label: string): string {
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} contains control characters.`);
  }
  return path.resolve(value);
}

export function getEnv(): EnvConfig {
  if (cachedEnv) {
    return cachedEnv;
  }

  const storageRoot = normalizeConfiguredPath(
    process.env.STORAGE_ROOT || path.join(process.cwd(), ".mymake-data"),
    "STORAGE_ROOT",
  );
  const configuredDatabasePath = process.env.SQLITE_DB_PATH
    ? normalizeConfiguredPath(process.env.SQLITE_DB_PATH, "SQLITE_DB_PATH")
    : resolveInsideRoot(storageRoot, "mymake.sqlite");
  const databasePath = resolveInsideRoot(
    storageRoot,
    path.relative(storageRoot, configuredDatabasePath),
  );

  cachedEnv = {
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    githubClientId: process.env.GITHUB_CLIENT_ID,
    githubClientSecret: process.env.GITHUB_CLIENT_SECRET,
    openaiApiKey: process.env.OPENAI_API_KEY,
    privyAppId: process.env.PRIVY_APP_ID || process.env.NEXT_PUBLIC_PRIVY_APP_ID,
    privyAppSecret: process.env.PRIVY_APP_SECRET,
    publicPrivyAppId: process.env.NEXT_PUBLIC_PRIVY_APP_ID || process.env.PRIVY_APP_ID,
    primaryOwnerEmail: process.env.PRIMARY_OWNER_EMAIL || "Amir.razagh76@gmail.com",
    appPasscode:
      process.env.APP_PASSCODE ||
      (process.env.NODE_ENV === "production"
        ? "set-a-real-passcode"
        : "mymake-local-passcode"),
    appBaseUrl: process.env.APP_BASE_URL,
    databasePath,
    port: Number(process.env.PORT || 3000),
    storageRoot,
    maxRevisionCount: 30,
  };

  return cachedEnv;
}
