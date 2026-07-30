import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  buildGitHubCallbackUrl,
  exchangeGitHubCodeForToken,
  GITHUB_REDIRECT_COOKIE_NAME,
  GITHUB_STATE_COOKIE_NAME,
  GITHUB_USER_COOKIE_NAME,
  getPublicAppBaseUrl,
  upsertGitHubConnection,
} from "@/lib/server/github";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const publicAppBaseUrl = getPublicAppBaseUrl(requestUrl.origin);
  const code = requestUrl.searchParams.get("code");
  const state = requestUrl.searchParams.get("state");
  const cookieStore = await cookies();
  const expectedState = cookieStore.get(GITHUB_STATE_COOKIE_NAME)?.value;
  const redirectPath = cookieStore.get(GITHUB_REDIRECT_COOKIE_NAME)?.value || "/";
  const userId = cookieStore.get(GITHUB_USER_COOKIE_NAME)?.value;

  cookieStore.delete(GITHUB_STATE_COOKIE_NAME);
  cookieStore.delete(GITHUB_REDIRECT_COOKIE_NAME);
  cookieStore.delete(GITHUB_USER_COOKIE_NAME);

  if (!code || !state || !expectedState || state !== expectedState || !userId) {
    const failedUrl = new URL(redirectPath, publicAppBaseUrl);
    failedUrl.searchParams.set("github", "failed");
    return NextResponse.redirect(failedUrl);
  }

  try {
    const redirectUri = buildGitHubCallbackUrl(requestUrl.origin);
    const token = await exchangeGitHubCodeForToken({
      code,
      redirectUri,
    });
    await upsertGitHubConnection(userId, token);

    const successUrl = new URL(redirectPath, publicAppBaseUrl);
    successUrl.searchParams.set("github", "connected");
    return NextResponse.redirect(successUrl);
  } catch {
    const failedUrl = new URL(redirectPath, publicAppBaseUrl);
    failedUrl.searchParams.set("github", "failed");
    return NextResponse.redirect(failedUrl);
  }
}
