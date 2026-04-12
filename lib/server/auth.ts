import { createHmac, timingSafeEqual } from "node:crypto";

import { PrivyClient, type User as PrivyUser } from "@privy-io/node";

import { type AppUserRecord } from "@/lib/types";
import { getDb } from "@/lib/server/db";
import { getEnv } from "@/lib/server/env";

const SESSION_PREFIX = "mymake-session:v2";
const SESSION_VERSION = 2;

export const SESSION_COOKIE_NAME = "mymake-session";
export const SESSION_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

interface PrivyProfileInput {
  userId?: string | null;
  email?: string | null;
  displayName?: string | null;
  avatarUrl?: string | null;
}

export interface AppSessionRecord {
  version: number;
  userId: string;
  email: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  issuedAt: string;
}

let privyClient: PrivyClient | null = null;

function nowIso(): string {
  return new Date().toISOString();
}

function getSessionSecret(): string {
  const secret =
    getEnv().privyAppSecret ||
    process.env.MYMAKE_SESSION_SECRET ||
    (process.env.NODE_ENV === "production"
      ? ""
      : "mymake-dev-session-secret");

  if (!secret) {
    throw new Error("PRIVY_APP_SECRET is not configured.");
  }

  return secret;
}

function getPrivyClient(): PrivyClient {
  if (privyClient) {
    return privyClient;
  }

  const env = getEnv();
  if (!env.privyAppId || !env.privyAppSecret) {
    throw new Error("Privy is not configured. Set NEXT_PUBLIC_PRIVY_APP_ID and PRIVY_APP_SECRET.");
  }

  privyClient = new PrivyClient({
    appId: env.privyAppId,
    appSecret: env.privyAppSecret,
  });

  return privyClient;
}

function signSessionPayload(encodedPayload: string): string {
  return createHmac("sha256", getSessionSecret())
    .update(`${SESSION_PREFIX}${encodedPayload}`)
    .digest("base64url");
}

function parseJson<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function extractEmail(user: PrivyUser): string | null {
  for (const account of user.linked_accounts || []) {
    if (account.type === "email" && "address" in account && typeof account.address === "string") {
      return account.address;
    }

    if (
      ["google_oauth", "apple_oauth", "linkedin_oauth"].includes(account.type) &&
      "email" in account &&
      typeof account.email === "string"
    ) {
      return account.email;
    }
  }

  return null;
}

function extractDisplayName(user: PrivyUser, email: string | null): string | null {
  for (const account of user.linked_accounts || []) {
    if ("name" in account && typeof account.name === "string" && account.name.trim()) {
      return account.name.trim();
    }

    if ("username" in account && typeof account.username === "string" && account.username.trim()) {
      return account.username.trim();
    }
  }

  if (email) {
    return email.split("@")[0] || email;
  }

  return null;
}

function extractAvatarUrl(user: PrivyUser): string | null {
  for (const account of user.linked_accounts || []) {
    if (
      "profile_picture_url" in account &&
      typeof account.profile_picture_url === "string" &&
      account.profile_picture_url
    ) {
      return account.profile_picture_url;
    }
  }

  return null;
}

function claimLegacyOwnershipIfNeeded(user: AppUserRecord): void {
  const email = user.email?.trim().toLowerCase();
  const primaryOwnerEmail = getEnv().primaryOwnerEmail.trim().toLowerCase();

  if (!email || email !== primaryOwnerEmail) {
    return;
  }

  getDb()
    .prepare(
      `UPDATE projects
          SET owner_user_id = ?
        WHERE owner_user_id IS NULL`,
    )
    .run(user.id);

  getDb()
    .prepare(
      `UPDATE github_connections
          SET owner_user_id = ?
        WHERE owner_user_id IS NULL`,
    )
    .run(user.id);
}

export function createSessionCookieValue(user: AppUserRecord): string {
  const payload: AppSessionRecord = {
    version: SESSION_VERSION,
    userId: user.id,
    email: user.email,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    issuedAt: nowIso(),
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = signSessionPayload(encodedPayload);
  return `${encodedPayload}.${signature}`;
}

export function readSessionCookieValue(value?: string | null): AppSessionRecord | null {
  if (!value) {
    return null;
  }

  const separatorIndex = value.lastIndexOf(".");
  if (separatorIndex <= 0) {
    return null;
  }

  const encodedPayload = value.slice(0, separatorIndex);
  const signature = value.slice(separatorIndex + 1);
  const expectedSignature = signSessionPayload(encodedPayload);
  const providedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);

  if (
    providedBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(providedBuffer, expectedBuffer)
  ) {
    return null;
  }

  const decoded = Buffer.from(encodedPayload, "base64url").toString("utf8");
  const payload = parseJson<AppSessionRecord>(decoded);
  if (!payload || payload.version !== SESSION_VERSION || !payload.userId) {
    return null;
  }

  return payload;
}

export async function isAuthorizedCookieValue(value?: string | null): Promise<boolean> {
  return Boolean(readSessionCookieValue(value));
}

export function getSessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_COOKIE_MAX_AGE,
  };
}

export function getAppUserById(userId: string): AppUserRecord | null {
  const row = getDb()
    .prepare(
      `SELECT id, email, display_name, avatar_url, created_at, last_seen_at
         FROM users
        WHERE id = ?
        LIMIT 1`,
    )
    .get(userId) as Record<string, unknown> | undefined;

  if (!row) {
    return null;
  }

  return {
    id: String(row.id),
    email: row.email ? String(row.email) : null,
    displayName: row.display_name ? String(row.display_name) : null,
    avatarUrl: row.avatar_url ? String(row.avatar_url) : null,
    createdAt: String(row.created_at),
    lastSeenAt: String(row.last_seen_at),
  };
}

export function doesUserOwnProject(projectId: string, userId: string): boolean {
  const row = getDb()
    .prepare(
      `SELECT 1
         FROM projects
        WHERE id = ?
          AND owner_user_id = ?
        LIMIT 1`,
    )
    .get(projectId, userId);

  return Boolean(row);
}

export async function upsertAppUserFromPrivyTokens(params: {
  accessToken: string;
  identityToken?: string | null;
  profile?: PrivyProfileInput | null;
}): Promise<AppUserRecord> {
  const client = getPrivyClient();
  const accessPayload = await client.utils().auth().verifyAccessToken(params.accessToken);
  let privyUser: PrivyUser | null = null;

  if (params.identityToken) {
    privyUser = await client.users().get({ id_token: params.identityToken });

    if (privyUser.id !== accessPayload.user_id) {
      throw new Error("Privy session mismatch. Please sign in again.");
    }
  }

  if (params.profile?.userId && params.profile.userId !== accessPayload.user_id) {
    throw new Error("Privy session mismatch. Please sign in again.");
  }

  const email = privyUser ? extractEmail(privyUser) : params.profile?.email?.trim() || null;
  const displayName = privyUser
    ? extractDisplayName(privyUser, email)
    : params.profile?.displayName?.trim() || (email ? email.split("@")[0] || email : null);
  const avatarUrl = privyUser
    ? extractAvatarUrl(privyUser)
    : params.profile?.avatarUrl?.trim() || null;
  const existingUser = getAppUserById(accessPayload.user_id);
  const createdAt = existingUser?.createdAt || nowIso();
  const lastSeenAt = nowIso();

  getDb()
    .prepare(
      `INSERT INTO users (
        id, email, display_name, avatar_url, created_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        email = excluded.email,
        display_name = excluded.display_name,
        avatar_url = excluded.avatar_url,
        last_seen_at = excluded.last_seen_at`,
    )
    .run(accessPayload.user_id, email, displayName, avatarUrl, createdAt, lastSeenAt);

  const appUser = getAppUserById(accessPayload.user_id);
  if (!appUser) {
    throw new Error("Could not create the MyMake user record.");
  }

  claimLegacyOwnershipIfNeeded(appUser);
  return appUser;
}
