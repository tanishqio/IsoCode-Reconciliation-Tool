import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../../src/app.js";
import { prisma } from "../../../src/db/prisma.js";
import { seedUsers } from "../../../src/db/seed-users.js";
import { hashToken } from "../../../src/modules/auth/tokens.js";
import { call, signIn } from "../../helpers/auth-client.js";
import { startServer, type TestServer } from "../../helpers/server.js";
import { assertTestDatabase } from "../../helpers/test-db.js";

const EXEC = { email: "exec@example.test", password: "executive-password-1" };
const FOUNDER = { email: "founder@example.test", password: "cofounder-password-1" };
const WRONG = "this-is-not-the-password";

let server: TestServer;
let base: string;

beforeAll(async () => {
  server = await startServer(createApp({ loginRateLimitMax: 10_000 }));
  base = server.baseUrl;
});

afterAll(async () => {
  await server.close();
  await prisma.$disconnect();
});

beforeEach(async () => {
  assertTestDatabase(process.env["DATABASE_URL"]); // never empty tables outside the test database
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "users" CASCADE');
  await seedUsers(
    prisma,
    [
      { ...EXEC, name: "Test Executive", role: "FINANCE_EXECUTIVE" },
      { ...FOUNDER, name: "Test Founder", role: "CO_FOUNDER" },
    ],
    4,
  );
});

const userRow = (email: string) => prisma.user.findUniqueOrThrow({ where: { email } });
const hoursFromNow = (hours: number) => new Date(Date.now() + hours * 3_600_000);

describe("sign in", () => {
  it("signs in with the right password: user, CSRF token and a session cookie", async () => {
    const result = await signIn(base, EXEC.email, EXEC.password);
    expect(result.status).toBe(200);
    expect(result.data.user).toMatchObject({
      email: EXEC.email,
      name: "Test Executive",
      role: "FINANCE_EXECUTIVE",
    });
    expect(result.data.user.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof result.csrf).toBe("string");
    expect(result.csrf.length).toBeGreaterThan(20);
    expect(result.cookie).toMatch(/^sid=.{40,}$/);
  });

  it("sets the cookie HttpOnly, SameSite=Lax, for the whole site, for about 12 hours", async () => {
    const result = await call(base, "POST", "/api/auth/login", { json: EXEC });
    const raw = result.setCookies.find((value) => value.startsWith("sid="))!;
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/SameSite=Lax/i);
    expect(raw).toMatch(/Path=\//i);
    expect(raw).not.toMatch(/Secure/i); // Secure is on only in production
    const maxAge = Number(/Max-Age=(\d+)/i.exec(raw)?.[1]);
    expect(Math.abs(maxAge - 12 * 3600)).toBeLessThan(5);
  });

  it("never returns the password or its hash, and tells browsers not to cache the answer", async () => {
    const result = await call(base, "POST", "/api/auth/login", { json: EXEC });
    const text = JSON.stringify(result.data).toLowerCase();
    expect(text).not.toContain("hash");
    expect(text).not.toContain(EXEC.password);
    expect(result.headers.get("cache-control")).toMatch(/no-store/);
  });

  it("ignores letter case and spaces around the email", async () => {
    const result = await call(base, "POST", "/api/auth/login", {
      json: { email: "  EXEC@Example.Test ", password: EXEC.password },
    });
    expect(result.status).toBe(200);
    expect(result.data.user.email).toBe(EXEC.email);
  });

  it("gives the same answer for a wrong password, an unknown email and a disabled account", async () => {
    await prisma.user.update({ where: { email: FOUNDER.email }, data: { isActive: false } });
    const wrongPassword = await call(base, "POST", "/api/auth/login", {
      json: { email: EXEC.email, password: WRONG },
    });
    const unknownEmail = await call(base, "POST", "/api/auth/login", {
      json: { email: "nobody@example.test", password: WRONG },
    });
    const disabled = await call(base, "POST", "/api/auth/login", { json: FOUNDER });

    for (const result of [wrongPassword, unknownEmail, disabled]) {
      expect(result.status).toBe(401);
      expect(result.data.error.code).toBe("UNAUTHENTICATED");
      expect(result.data.error.message).toBe(wrongPassword.data.error.message);
      expect(result.setCookies).toHaveLength(0);
    }
  });

  it("rejects a bad request body with 422", async () => {
    const cases = [
      {},
      { email: EXEC.email },
      { password: EXEC.password },
      { email: "", password: "x" },
      { email: EXEC.email, password: EXEC.password, role: "CO_FOUNDER" }, // extra field
      { email: EXEC.email, password: "a".repeat(80) }, // over bcrypt's 72-byte limit
      { email: EXEC.email, password: "é".repeat(40) }, // 80 bytes in UTF-8
    ];
    for (const json of cases) {
      const result = await call(base, "POST", "/api/auth/login", { json });
      expect(result.status, JSON.stringify(json).slice(0, 40)).toBe(422);
      expect(result.data.error.code).toBe("VALIDATION_FAILED");
    }
  });

  it("stores only a hash of the session token, and records the sign-in", async () => {
    const result = await signIn(base, EXEC.email, EXEC.password);
    const token = result.cookie.slice("sid=".length);
    const rows = await prisma.session.findMany();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.tokenHash).toBe(hashToken(token));
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.tokenHash).not.toBe(token);
    expect(row.csrfToken).toBe(result.csrf);
    expect(Math.abs(row.expiresAt.getTime() - hoursFromNow(12).getTime())).toBeLessThan(10_000);
    expect((await userRow(EXEC.email)).lastLoginAt).toBeInstanceOf(Date);
  });
});

describe("lockout after repeated wrong passwords", () => {
  const wrongTimes = async (count: number, email = EXEC.email) => {
    for (let i = 0; i < count; i++) {
      const result = await call(base, "POST", "/api/auth/login", {
        json: { email, password: WRONG },
      });
      expect(result.status).toBe(401);
    }
  };

  it("counts wrong passwords and clears the count after a correct one", async () => {
    await wrongTimes(3);
    expect((await userRow(EXEC.email)).failedLoginCount).toBe(3);
    expect((await signIn(base, EXEC.email, EXEC.password)).status).toBe(200);
    const after = await userRow(EXEC.email);
    expect(after.failedLoginCount).toBe(0);
    expect(after.lockedUntil).toBeNull();
  });

  it("locks the account after 5 wrong passwords, for about 15 minutes", async () => {
    await wrongTimes(5);
    const locked = await userRow(EXEC.email);
    expect(locked.lockedUntil).toBeInstanceOf(Date);
    expect(Math.abs(locked.lockedUntil!.getTime() - (Date.now() + 15 * 60_000))).toBeLessThan(
      10_000,
    );
    expect(locked.failedLoginCount).toBe(0);
  });

  it("refuses even the correct password while locked, with the same message and no cookie", async () => {
    const wrong = await call(base, "POST", "/api/auth/login", {
      json: { email: EXEC.email, password: WRONG },
    });
    await wrongTimes(4);
    const attempt = await call(base, "POST", "/api/auth/login", { json: EXEC });
    expect(attempt.status).toBe(401);
    expect(attempt.data.error.message).toBe(wrong.data.error.message);
    expect(attempt.setCookies).toHaveLength(0);
    expect(await prisma.session.count()).toBe(0);
  });

  it("lets the user in again once the lock has ended", async () => {
    await wrongTimes(5);
    await prisma.user.update({
      where: { email: EXEC.email },
      data: { lockedUntil: new Date(Date.now() - 1000) },
    });
    expect((await signIn(base, EXEC.email, EXEC.password)).status).toBe(200);
    expect((await userRow(EXEC.email)).lockedUntil).toBeNull();
  });

  it("does not lock the other account", async () => {
    await wrongTimes(5);
    expect((await signIn(base, FOUNDER.email, FOUNDER.password)).status).toBe(200);
  });
});

describe("session: who am I", () => {
  it("returns the user and the same CSRF token that sign-in returned", async () => {
    const login = await signIn(base, EXEC.email, EXEC.password);
    const me = await call(base, "GET", "/api/auth/me", { cookie: login.cookie });
    expect(me.status).toBe(200);
    expect(me.data.user.email).toBe(EXEC.email);
    expect(me.data.csrfToken).toBe(login.csrf);
    expect(JSON.stringify(me.data).toLowerCase()).not.toContain("hash");
    expect(me.headers.get("cache-control")).toMatch(/no-store/);
  });

  it("answers 401 with no cookie, an empty cookie or a made-up token", async () => {
    for (const cookie of [undefined, "sid=", "sid=not-a-real-token", "other=1"]) {
      const result = await call(base, "GET", "/api/auth/me", { cookie });
      expect(result.status, String(cookie)).toBe(401);
      expect(result.data.error.code).toBe("UNAUTHENTICATED");
    }
  });

  it("answers 401 and clears the cookie once the session has expired", async () => {
    const login = await signIn(base, EXEC.email, EXEC.password);
    await prisma.session.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    const me = await call(base, "GET", "/api/auth/me", { cookie: login.cookie });
    expect(me.status).toBe(401);
    expect(me.setCookies.some((value) => /^sid=;/.test(value))).toBe(true);
  });

  it("stops working as soon as the user is disabled", async () => {
    const login = await signIn(base, EXEC.email, EXEC.password);
    expect((await call(base, "GET", "/api/auth/me", { cookie: login.cookie })).status).toBe(200);
    await prisma.user.update({ where: { email: EXEC.email }, data: { isActive: false } });
    expect((await call(base, "GET", "/api/auth/me", { cookie: login.cookie })).status).toBe(401);
  });

  it("gives each sign-in its own session", async () => {
    const first = await signIn(base, EXEC.email, EXEC.password);
    const second = await signIn(base, EXEC.email, EXEC.password);
    expect(first.cookie).not.toBe(second.cookie);
    expect(first.csrf).not.toBe(second.csrf);
    expect(await prisma.session.count()).toBe(2);
  });

  it("removes sessions that have already expired when anyone signs in", async () => {
    await signIn(base, EXEC.email, EXEC.password);
    await prisma.session.updateMany({ data: { expiresAt: new Date(Date.now() - 60_000) } });
    await signIn(base, FOUNDER.email, FOUNDER.password);
    const rows = await prisma.session.findMany({ include: { user: true } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.user.email).toBe(FOUNDER.email);
  });

  it("deletes a user's sessions when the user is deleted", async () => {
    await signIn(base, EXEC.email, EXEC.password);
    await prisma.user.delete({ where: { email: EXEC.email } });
    expect(await prisma.session.count()).toBe(0);
  });
});

describe("sign out and the CSRF check", () => {
  it("refuses to sign out without the CSRF token, and keeps the session", async () => {
    const login = await signIn(base, EXEC.email, EXEC.password);
    const result = await call(base, "POST", "/api/auth/logout", { cookie: login.cookie });
    expect(result.status).toBe(403);
    expect(result.data.error.code).toBe("FORBIDDEN");
    expect((await call(base, "GET", "/api/auth/me", { cookie: login.cookie })).status).toBe(200);
  });

  it("refuses a wrong CSRF token, including another user's valid one", async () => {
    const exec = await signIn(base, EXEC.email, EXEC.password);
    const founder = await signIn(base, FOUNDER.email, FOUNDER.password);
    for (const csrf of ["wrong", founder.csrf]) {
      const result = await call(base, "POST", "/api/auth/logout", { cookie: exec.cookie, csrf });
      expect(result.status).toBe(403);
    }
    expect(await prisma.session.count()).toBe(2);
  });

  it("signs out with the right token: 204, session deleted, cookie cleared, old cookie dead", async () => {
    const login = await signIn(base, EXEC.email, EXEC.password);
    const out = await call(base, "POST", "/api/auth/logout", {
      cookie: login.cookie,
      csrf: login.csrf,
    });
    expect(out.status).toBe(204);
    expect(out.setCookies.some((value) => /^sid=;/.test(value))).toBe(true);
    expect(await prisma.session.count()).toBe(0);
    expect((await call(base, "GET", "/api/auth/me", { cookie: login.cookie })).status).toBe(401);
  });

  it("signing out one browser leaves the user's other session alone", async () => {
    const first = await signIn(base, EXEC.email, EXEC.password);
    const second = await signIn(base, EXEC.email, EXEC.password);
    await call(base, "POST", "/api/auth/logout", { cookie: first.cookie, csrf: first.csrf });
    expect((await call(base, "GET", "/api/auth/me", { cookie: second.cookie })).status).toBe(200);
  });

  it("answers 401, not 403, when signing out without being signed in", async () => {
    const result = await call(base, "POST", "/api/auth/logout", { csrf: "anything" });
    expect(result.status).toBe(401);
  });
});

describe("rate limit on sign-in attempts", () => {
  it("answers 429 after too many failed attempts from one address, then stays blocked", async () => {
    const limited = await startServer(createApp({ loginRateLimitMax: 3 }));
    try {
      for (let i = 0; i < 3; i++) {
        const result = await call(limited.baseUrl, "POST", "/api/auth/login", {
          json: { email: "nobody@example.test", password: WRONG },
        });
        expect(result.status).toBe(401);
      }
      const blocked = await call(limited.baseUrl, "POST", "/api/auth/login", {
        json: { email: "nobody@example.test", password: WRONG },
      });
      expect(blocked.status).toBe(429);
      expect(blocked.data.error.code).toBe("RATE_LIMITED");
      expect((await call(limited.baseUrl, "POST", "/api/auth/login", { json: EXEC })).status).toBe(
        429,
      );
    } finally {
      await limited.close();
    }
  });

  it("does not count successful sign-ins", async () => {
    const limited = await startServer(createApp({ loginRateLimitMax: 3 }));
    try {
      for (let i = 0; i < 6; i++) {
        const result = await call(limited.baseUrl, "POST", "/api/auth/login", { json: EXEC });
        expect(result.status).toBe(200);
      }
    } finally {
      await limited.close();
    }
  });
});
