import { NextResponse } from "next/server";

import { getGitHubConnectionStatus } from "@/lib/server/github";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(getGitHubConnectionStatus());
}
