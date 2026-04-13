import { nanoid } from "nanoid";

import { getDb } from "@/lib/server/db";
import { getEnv } from "@/lib/server/env";
import type { GitHubConnectionRecord, GitHubRepoSummary } from "@/lib/types";

const GITHUB_API_BASE = "https://api.github.com";
export const GITHUB_STATE_COOKIE_NAME = "mymake-github-oauth-state";
export const GITHUB_REDIRECT_COOKIE_NAME = "mymake-github-oauth-redirect";
export const GITHUB_USER_COOKIE_NAME = "mymake-github-oauth-user";

interface StoredGitHubConnection {
  id: string;
  ownerUserId: string;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  accessToken: string;
  createdAt: string;
  updatedAt: string;
}

interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string | null;
}

interface GitHubRepositoryPayload {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  default_branch: string;
  clone_url: string;
  html_url: string;
  updated_at: string;
  owner: {
    login: string;
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function getPublicAppBaseUrl(fallbackOrigin?: string | null): string {
  const configuredBaseUrl = getEnv().appBaseUrl?.trim();
  if (configuredBaseUrl) {
    return trimTrailingSlash(configuredBaseUrl);
  }

  if (fallbackOrigin) {
    return trimTrailingSlash(fallbackOrigin);
  }

  return "http://localhost:3000";
}

export function buildGitHubCallbackUrl(fallbackOrigin?: string | null): string {
  return new URL("/api/github/callback", getPublicAppBaseUrl(fallbackOrigin)).toString();
}

export function isGitHubConfigured(): boolean {
  const env = getEnv();
  return Boolean(env.githubClientId && env.githubClientSecret);
}

function mapConnectionRow(
  row: Record<string, unknown> | undefined,
): StoredGitHubConnection | null {
  if (!row) {
    return null;
  }

  return {
    id: String(row.id),
    ownerUserId: String(row.owner_user_id),
    login: String(row.login),
    name: row.name ? String(row.name) : null,
    avatarUrl: row.avatar_url ? String(row.avatar_url) : null,
    accessToken: String(row.access_token),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function getStoredGitHubConnection(userId: string): StoredGitHubConnection | null {
  const row = getDb()
    .prepare(
      `SELECT *
         FROM github_connections
        WHERE owner_user_id = ?
        ORDER BY updated_at DESC
        LIMIT 1`,
    )
    .get(userId) as Record<string, unknown> | undefined;

  return mapConnectionRow(row);
}

export function getGitHubConnectionById(
  userId: string,
  connectionId: string,
): StoredGitHubConnection | null {
  const row = getDb()
    .prepare(
      `SELECT *
         FROM github_connections
        WHERE id = ?
          AND owner_user_id = ?
        LIMIT 1`,
    )
    .get(connectionId, userId) as Record<string, unknown> | undefined;

  return mapConnectionRow(row);
}

export function getGitHubConnectionStatus(userId: string | null): GitHubConnectionRecord {
  const connection = userId ? getStoredGitHubConnection(userId) : null;
  return {
    configured: isGitHubConfigured(),
    connected: Boolean(connection),
    login: connection?.login || null,
    name: connection?.name || null,
    avatarUrl: connection?.avatarUrl || null,
  };
}

function getGitHubHeaders(token: string): HeadersInit {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "MyMake",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function githubFetch<T>(
  input: string,
  init: RequestInit & { token?: string; userId?: string } = {},
): Promise<T> {
  const token = init.token || (init.userId ? getStoredGitHubConnection(init.userId)?.accessToken : null);
  if (!token) {
    throw new Error("Connect GitHub first to use repo sync.");
  }

  const response = await fetch(`${GITHUB_API_BASE}${input}`, {
    ...init,
    headers: {
      ...getGitHubHeaders(token),
      ...(init.headers || {}),
    },
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`GitHub request failed (${response.status}): ${message}`);
  }

  return (await response.json()) as T;
}

export function buildGitHubAuthorizeUrl(params: {
  state: string;
  redirectUri: string;
}): string {
  const env = getEnv();
  if (!env.githubClientId) {
    throw new Error("GITHUB_CLIENT_ID is not configured.");
  }

  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", env.githubClientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("scope", "read:user repo");
  url.searchParams.set("state", params.state);
  return url.toString();
}

export async function exchangeGitHubCodeForToken(params: {
  code: string;
  redirectUri: string;
}): Promise<string> {
  const env = getEnv();
  if (!env.githubClientId || !env.githubClientSecret) {
    throw new Error("GitHub OAuth is not configured yet.");
  }

  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: env.githubClientId,
      client_secret: env.githubClientSecret,
      code: params.code,
      redirect_uri: params.redirectUri,
    }),
  });

  const payload = (await response.json()) as {
    access_token?: string;
    error_description?: string;
  };

  if (!response.ok || !payload.access_token) {
    throw new Error(payload.error_description || "GitHub OAuth exchange failed.");
  }

  return payload.access_token;
}

export async function fetchGitHubUser(token: string): Promise<GitHubUser> {
  const response = await fetch(`${GITHUB_API_BASE}/user`, {
    headers: getGitHubHeaders(token),
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`GitHub user lookup failed (${response.status}): ${message}`);
  }

  return (await response.json()) as GitHubUser;
}

export async function upsertGitHubConnection(
  userId: string,
  token: string,
): Promise<StoredGitHubConnection> {
  const user = await fetchGitHubUser(token);
  const existing = getStoredGitHubConnection(userId);
  const createdAt = existing?.createdAt || nowIso();
  const updatedAt = nowIso();
  const id = existing?.id || nanoid(10);

  getDb()
    .prepare(
      `DELETE FROM github_connections
        WHERE owner_user_id = ?`,
    )
    .run(userId);
  getDb()
    .prepare(
      `INSERT INTO github_connections (
        id, owner_user_id, login, name, avatar_url, access_token, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, userId, user.login, user.name, user.avatar_url, token, createdAt, updatedAt);

  return {
    id,
    ownerUserId: userId,
    login: user.login,
    name: user.name,
    avatarUrl: user.avatar_url,
    accessToken: token,
    createdAt,
    updatedAt,
  };
}

export async function listGitHubRepos(userId: string): Promise<GitHubRepoSummary[]> {
  const repositories = await githubFetch<GitHubRepositoryPayload[]>(
    "/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member",
    { userId },
  );

  return repositories.map((repo) => ({
    id: repo.id,
    owner: repo.owner.login,
    name: repo.name,
    fullName: repo.full_name,
    private: repo.private,
    defaultBranch: repo.default_branch || "main",
    cloneUrl: repo.clone_url,
    htmlUrl: repo.html_url,
    updatedAt: repo.updated_at,
  }));
}

export async function getGitHubRepo(
  owner: string,
  repo: string,
  userId: string,
): Promise<GitHubRepoSummary> {
  const repository = await githubFetch<GitHubRepositoryPayload>(`/repos/${owner}/${repo}`, {
    userId,
  });
  return {
    id: repository.id,
    owner: repository.owner.login,
    name: repository.name,
    fullName: repository.full_name,
    private: repository.private,
    defaultBranch: repository.default_branch || "main",
    cloneUrl: repository.clone_url,
    htmlUrl: repository.html_url,
    updatedAt: repository.updated_at,
  };
}

export async function createGitHubRepo(
  params: {
    name: string;
    isPrivate: boolean;
    description?: string | null;
  },
  userId: string,
): Promise<GitHubRepoSummary> {
  const repository = await githubFetch<GitHubRepositoryPayload>("/user/repos", {
    method: "POST",
    userId,
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: params.name,
      private: params.isPrivate,
      description: params.description || undefined,
      auto_init: false,
    }),
  });

  return {
    id: repository.id,
    owner: repository.owner.login,
    name: repository.name,
    fullName: repository.full_name,
    private: repository.private,
    defaultBranch: repository.default_branch || "main",
    cloneUrl: repository.clone_url,
    htmlUrl: repository.html_url,
    updatedAt: repository.updated_at,
  };
}
