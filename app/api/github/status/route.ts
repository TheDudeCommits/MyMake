import { NextResponse } from "next/server";

import { requireCurrentAppUser } from "@/lib/server/auth-next";
import { getGitHubConnectionStatus } from "@/lib/server/github";

export const runtime = "nodejs";

export async function GET() {
  const user = await requireCurrentAppUser();
  return NextResponse.json(getGitHubConnectionStatus(user.id));
}
