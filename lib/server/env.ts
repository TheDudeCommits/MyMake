import path from "node:path";

interface EnvConfig {
  anthropicApiKey?: string;
  appPasscode: string;
  databasePath: string;
  port: number;
  storageRoot: string;
  maxRevisionCount: number;
}

let cachedEnv: EnvConfig | null = null;

export function getEnv(): EnvConfig {
  if (cachedEnv) {
    return cachedEnv;
  }

  const storageRoot =
    process.env.STORAGE_ROOT || path.join(process.cwd(), ".mymake-data");
  const databasePath =
    process.env.SQLITE_DB_PATH || path.join(storageRoot, "mymake.sqlite");

  cachedEnv = {
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    appPasscode:
      process.env.APP_PASSCODE ||
      (process.env.NODE_ENV === "production"
        ? "set-a-real-passcode"
        : "mymake-local-passcode"),
    databasePath,
    port: Number(process.env.PORT || 3000),
    storageRoot,
    maxRevisionCount: 30,
  };

  return cachedEnv;
}
