import { NextResponse, type NextRequest } from "next/server";

const EXCLUDED_PREFIXES = [
  "/_next",
  "/favicon.ico",
  "/auth",
  "/published",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/github/callback",
];

function hasSessionCookie(value?: string | null): boolean {
  if (!value) {
    return false;
  }

  const separatorIndex = value.lastIndexOf(".");
  return separatorIndex > 0;
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (EXCLUDED_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return NextResponse.next();
  }

  const sessionValue = request.cookies.get("mymake-session")?.value;
  if (hasSessionCookie(sessionValue)) {
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
