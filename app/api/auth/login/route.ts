import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";

import { createSessionSignature, SESSION_COOKIE_NAME } from "@/lib/server/auth";
import { getEnv } from "@/lib/server/env";

export const runtime = "nodejs";

const bodySchema = z.object({
  passcode: z.string().min(1),
});

export async function POST(request: Request) {
  try {
    const body = bodySchema.parse(await request.json());
    if (body.passcode !== getEnv().appPasscode) {
      return NextResponse.json({ error: "That passcode is not correct." }, { status: 401 });
    }

    const signature = await createSessionSignature(body.passcode);
    cookies().set(SESSION_COOKIE_NAME, signature, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Login failed." },
      { status: 400 },
    );
  }
}
