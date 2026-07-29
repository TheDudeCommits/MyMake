import { cookies } from "next/headers";

import {
  getAppUserById,
  readSessionCookieValue,
  SESSION_COOKIE_NAME,
  type AppSessionRecord,
} from "@/lib/server/auth";
import { type AppUserRecord } from "@/lib/types";

export async function getCurrentAppSession(): Promise<AppSessionRecord | null> {
  const cookieStore = await cookies();
  return readSessionCookieValue(cookieStore.get(SESSION_COOKIE_NAME)?.value);
}

export async function requireCurrentAppSession(): Promise<AppSessionRecord> {
  const session = await getCurrentAppSession();
  if (!session) {
    throw new Error("Unauthorized");
  }

  return session;
}

export async function getCurrentAppUser(): Promise<AppUserRecord | null> {
  const session = await getCurrentAppSession();
  if (!session) {
    return null;
  }

  return getAppUserById(session.userId);
}

export async function requireCurrentAppUser(): Promise<AppUserRecord> {
  const session = await requireCurrentAppSession();
  const user = getAppUserById(session.userId);
  if (!user) {
    throw new Error("Unauthorized");
  }

  return user;
}
