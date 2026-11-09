import bcrypt from "bcryptjs";

// bcrypt only reads the first 72 bytes of a password. Anything longer would silently be cut,
// so two different long passwords could match. Reject it instead.
export const MAX_PASSWORD_BYTES = 72;

export function isPasswordLengthOk(password: string): boolean {
  return Buffer.byteLength(password, "utf8") <= MAX_PASSWORD_BYTES;
}

export function hashPassword(password: string, cost: number): Promise<string> {
  return bcrypt.hash(password, cost);
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

let dummyHash: Promise<string> | null = null;

/**
 * A valid hash that matches nothing anyone can type. Signing in with an email that does not
 * exist still compares against this, so the response time does not reveal which emails exist.
 */
export function getDummyHash(cost: number): Promise<string> {
  dummyHash ??= bcrypt.hash(`dummy-${Math.random()}-${Date.now()}`, cost);
  return dummyHash;
}
