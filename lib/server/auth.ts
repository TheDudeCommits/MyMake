const SESSION_PREFIX = "mymake-session:";
export const SESSION_COOKIE_NAME = "mymake-session";

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

export async function createSessionSignature(passcode: string): Promise<string> {
  const encoded = new TextEncoder().encode(`${SESSION_PREFIX}${passcode}`);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return toHex(digest);
}

export async function isAuthorizedCookieValue(value?: string | null): Promise<boolean> {
  if (!value) {
    return false;
  }

  const expected = await createSessionSignature(
    process.env.APP_PASSCODE ||
      (process.env.NODE_ENV === "production"
        ? "set-a-real-passcode"
        : "mymake-local-passcode"),
  );

  return value === expected;
}
