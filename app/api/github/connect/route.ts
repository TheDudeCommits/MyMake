import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { nanoid } from "nanoid";

import { requireCurrentAppUser } from "@/lib/server/auth-next";
import {
  buildGitHubCallbackUrl,
  buildGitHubAuthorizeUrl,
  GITHUB_REDIRECT_COOKIE_NAME,
  GITHUB_STATE_COOKIE_NAME,
  GITHUB_USER_COOKIE_NAME,
  isGitHubConfigured,
} from "@/lib/server/github";

export const runtime = "nodejs";

export async function GET(request: Request) {
  if (!isGitHubConfigured()) {
    return NextResponse.json(
      { error: "GitHub OAuth is not configured yet. Add GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET first." },
      { status: 400 },
    );
  }

  const user = await requireCurrentAppUser();
  const requestUrl = new URL(request.url);
  const state = nanoid(24);
  const redirectPath = requestUrl.searchParams.get("redirect") || "/";
  const redirectUri = buildGitHubCallbackUrl(requestUrl.origin);
  const authorizeUrl = buildGitHubAuthorizeUrl({
    state,
    redirectUri,
  });

  cookies().set(GITHUB_STATE_COOKIE_NAME, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 10,
  });
  cookies().set(GITHUB_REDIRECT_COOKIE_NAME, redirectPath, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 10,
  });
  cookies().set(GITHUB_USER_COOKIE_NAME, user.id, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 10,
  });

  return NextResponse.redirect(authorizeUrl);
}
