import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";

import {
  createSessionCookieValue,
  getSessionCookieOptions,
  SESSION_COOKIE_NAME,
  upsertAppUserFromPrivyTokens,
} from "@/lib/server/auth";

export const runtime = "nodejs";

const bodySchema = z.object({
  accessToken: z.string().min(1),
  identityToken: z.string().min(1).optional().nullable(),
  profile: z
    .object({
      userId: z.string().min(1).optional().nullable(),
      email: z.string().email().optional().nullable(),
      displayName: z.string().min(1).optional().nullable(),
      avatarUrl: z.string().url().optional().nullable(),
    })
    .optional()
    .nullable(),
});

export async function POST(request: Request) {
  try {
    const body = bodySchema.parse(await request.json());
    const user = await upsertAppUserFromPrivyTokens(body);
    const cookieStore = await cookies();
    cookieStore.set(SESSION_COOKIE_NAME, createSessionCookieValue(user), getSessionCookieOptions());

    return NextResponse.json({
      ok: true,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Login failed." },
      { status: 401 },
    );
  }
}
