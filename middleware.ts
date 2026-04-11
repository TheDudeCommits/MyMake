import { NextResponse, type NextRequest } from "next/server";

import { isAuthorizedCookieValue } from "@/lib/server/auth";

const EXCLUDED_PREFIXES = [
  "/_next",
  "/favicon.ico",
  "/auth",
  "/published",
  "/api/auth/login",
];

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (EXCLUDED_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return NextResponse.next();
  }

  const sessionValue = request.cookies.get("mymake-session")?.value;
  if (await isAuthorizedCookieValue(sessionValue)) {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const loginUrl = new URL("/auth", request.url);
  loginUrl.searchParams.set("redirect", pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!.*\\..*).*)"],
};
