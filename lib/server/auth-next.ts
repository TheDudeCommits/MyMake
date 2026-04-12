import { cookies } from "next/headers";

import {
  getAppUserById,
  readSessionCookieValue,
  SESSION_COOKIE_NAME,
  type AppSessionRecord,
} from "@/lib/server/auth";
import { type AppUserRecord } from "@/lib/types";

export function getCurrentAppSession(): AppSessionRecord | null {
  return readSessionCookieValue(cookies().get(SESSION_COOKIE_NAME)?.value);
}

export function requireCurrentAppSession(): AppSessionRecord {
  const session = getCurrentAppSession();
  if (!session) {
    throw new Error("Unauthorized");
  }

  return session;
}

export async function getCurrentAppUser(): Promise<AppUserRecord | null> {
  const session = getCurrentAppSession();
  if (!session) {
    return null;
  }

  return getAppUserById(session.userId);
}

export async function requireCurrentAppUser(): Promise<AppUserRecord> {
  const session = requireCurrentAppSession();
  const user = getAppUserById(session.userId);
  if (!user) {
    throw new Error("Unauthorized");
  }

  return user;
}
