import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  exchangeGitHubCodeForToken,
  GITHUB_REDIRECT_COOKIE_NAME,
  GITHUB_STATE_COOKIE_NAME,
  upsertGitHubConnection,
} from "@/lib/server/github";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get("code");
  const state = requestUrl.searchParams.get("state");
  const expectedState = cookies().get(GITHUB_STATE_COOKIE_NAME)?.value;
  const redirectPath = cookies().get(GITHUB_REDIRECT_COOKIE_NAME)?.value || "/";

  cookies().delete(GITHUB_STATE_COOKIE_NAME);
  cookies().delete(GITHUB_REDIRECT_COOKIE_NAME);

  if (!code || !state || !expectedState || state !== expectedState) {
    const failedUrl = new URL(redirectPath, requestUrl.origin);
    failedUrl.searchParams.set("github", "failed");
    return NextResponse.redirect(failedUrl);
  }

  try {
    const redirectUri = new URL("/api/github/callback", requestUrl.origin).toString();
    const token = await exchangeGitHubCodeForToken({
      code,
      redirectUri,
    });
    await upsertGitHubConnection(token);

    const successUrl = new URL(redirectPath, requestUrl.origin);
    successUrl.searchParams.set("github", "connected");
    return NextResponse.redirect(successUrl);
  } catch {
    const failedUrl = new URL(redirectPath, requestUrl.origin);
    failedUrl.searchParams.set("github", "failed");
    return NextResponse.redirect(failedUrl);
  }
}
