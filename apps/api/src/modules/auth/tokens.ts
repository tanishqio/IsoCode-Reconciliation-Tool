import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** A random token for the session cookie: 32 random bytes, 256 bits. */
export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/** A random token the page must send back on requests that change data. */
export function generateCsrfToken(): string {
  return randomBytes(24).toString("base64url");
}

/** Only this hash is stored in the database, never the token itself. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Compares two strings without leaking, through timing, how many leading characters matched. */
export function safeEqual(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}
