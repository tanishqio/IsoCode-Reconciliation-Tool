import { describe, expect, it } from "vitest";
import {
  MAX_PASSWORD_BYTES,
  getDummyHash,
  hashPassword,
  isPasswordLengthOk,
  verifyPassword,
} from "../../../src/lib/passwords.js";
import {
  generateCsrfToken,
  generateSessionToken,
  hashToken,
  safeEqual,
} from "../../../src/modules/auth/tokens.js";

describe("session and CSRF tokens", () => {
  it("are long, URL-safe and different every time", () => {
    const session = new Set(Array.from({ length: 50 }, generateSessionToken));
    const csrf = new Set(Array.from({ length: 50 }, generateCsrfToken));
    expect(session.size).toBe(50);
    expect(csrf.size).toBe(50);
    for (const token of [...session, ...csrf]) expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(generateSessionToken()).toHaveLength(43); // 32 random bytes
    expect(generateCsrfToken()).toHaveLength(32); // 24 random bytes
  });

  it("are stored as a SHA-256 hash that does not contain the token", () => {
    const token = generateSessionToken();
    const hash = hashToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(hashToken(token));
    expect(hash).not.toContain(token);
    expect(hashToken(`${token}x`)).not.toBe(hash);
  });
});

describe("safeEqual", () => {
  it("is true only for identical strings, whatever their lengths", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
    expect(safeEqual("", "a")).toBe(false);
  });
});

describe("passwords", () => {
  it("hashes with bcrypt and verifies the right password only", async () => {
    const hash = await hashPassword("a-good-password", 4);
    expect(hash).toMatch(/^\$2[aby]\$04\$/);
    expect(hash).not.toContain("a-good-password");
    expect(await verifyPassword("a-good-password", hash)).toBe(true);
    expect(await verifyPassword("a-good-passwore", hash)).toBe(false);
    expect(await verifyPassword("", hash)).toBe(false);
  });

  it("gives two different hashes for the same password (random salt)", async () => {
    expect(await hashPassword("same", 4)).not.toBe(await hashPassword("same", 4));
  });

  it("limits a password to 72 bytes, counting multi-byte characters", () => {
    expect(MAX_PASSWORD_BYTES).toBe(72);
    expect(isPasswordLengthOk("a".repeat(72))).toBe(true);
    expect(isPasswordLengthOk("a".repeat(73))).toBe(false);
    expect(isPasswordLengthOk("é".repeat(36))).toBe(true); // 72 bytes
    expect(isPasswordLengthOk("é".repeat(37))).toBe(false); // 74 bytes
  });

  it("has a dummy hash that is valid but matches no ordinary password", async () => {
    const dummy = await getDummyHash(4);
    expect(dummy).toMatch(/^\$2[aby]\$04\$/);
    expect(await getDummyHash(4)).toBe(dummy); // made once and reused
    expect(await verifyPassword("password", dummy)).toBe(false);
    expect(await verifyPassword("", dummy)).toBe(false);
  });
});
