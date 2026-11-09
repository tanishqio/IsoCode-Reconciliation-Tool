import type { PrismaClient } from "../../../generated/prisma/client.js";
import { AppError } from "../../lib/errors.js";
import { getDummyHash, verifyPassword } from "../../lib/passwords.js";
import type { AuthSession, AuthUser } from "./auth.types.js";
import { generateCsrfToken, generateSessionToken, hashToken } from "./tokens.js";

export interface AuthServiceOptions {
  prisma: PrismaClient;
  bcryptCost: number;
  sessionTtlMs: number;
  maxFailedAttempts: number;
  lockMs: number;
  /** Replaced in tests to control time. */
  now?: () => Date;
}

export interface LoginResult {
  /** The raw session token. Goes into the cookie; only its hash is stored. */
  token: string;
  csrfToken: string;
  expiresAt: Date;
  user: AuthUser;
}

export type AuthService = ReturnType<typeof createAuthService>;

// How often a session's "last seen" time is refreshed. Avoids a database write on every request.
const LAST_SEEN_REFRESH_MS = 60_000;

// One message for every kind of sign-in failure: unknown email, wrong password, disabled account,
// locked account. Different messages would tell an attacker which emails exist.
const SIGN_IN_FAILED = "Email or password is not correct.";

function signInFailed(): AppError {
  return new AppError("UNAUTHENTICATED", 401, SIGN_IN_FAILED);
}

export function createAuthService(options: AuthServiceOptions) {
  const { prisma, bcryptCost, sessionTtlMs, maxFailedAttempts, lockMs } = options;
  const now = options.now ?? (() => new Date());

  async function login(input: { email: string; password: string }): Promise<LoginResult> {
    const user = await prisma.user.findUnique({ where: { email: input.email } });

    // Always compare against a real hash, even when the email is unknown, so the time taken
    // is about the same either way.
    const passwordOk = await verifyPassword(
      input.password,
      user?.passwordHash ?? (await getDummyHash(bcryptCost)),
    );

    if (!user || !user.isActive) throw signInFailed();

    const at = now();
    if (user.lockedUntil && user.lockedUntil > at) throw signInFailed();

    if (!passwordOk) {
      const updated = await prisma.user.update({
        where: { id: user.id },
        data: { failedLoginCount: { increment: 1 } },
        select: { failedLoginCount: true },
      });
      if (updated.failedLoginCount >= maxFailedAttempts) {
        // Lock, and start the count again for when the lock ends.
        await prisma.user.update({
          where: { id: user.id },
          data: { lockedUntil: new Date(at.getTime() + lockMs), failedLoginCount: 0 },
        });
      }
      throw signInFailed();
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: at },
    });

    // Housekeeping: remove sessions that have already expired.
    await prisma.session.deleteMany({ where: { expiresAt: { lt: at } } });

    const token = generateSessionToken();
    const csrfToken = generateCsrfToken();
    const expiresAt = new Date(at.getTime() + sessionTtlMs);
    await prisma.session.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(token),
        csrfToken,
        expiresAt,
        createdAt: at,
        lastSeenAt: at,
      },
    });

    return {
      token,
      csrfToken,
      expiresAt,
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
    };
  }

  /** The session for a cookie token, or null if it is unknown, expired, or its user is disabled. */
  async function getSession(token: string): Promise<AuthSession | null> {
    const row = await prisma.session.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { user: true },
    });
    if (!row) return null;

    const at = now();
    if (row.expiresAt <= at || !row.user.isActive) return null;

    if (at.getTime() - row.lastSeenAt.getTime() > LAST_SEEN_REFRESH_MS) {
      await prisma.session.update({ where: { id: row.id }, data: { lastSeenAt: at } });
    }

    return {
      id: row.id,
      csrfToken: row.csrfToken,
      user: { id: row.user.id, name: row.user.name, email: row.user.email, role: row.user.role },
    };
  }

  /** Ends the session for a cookie token. Does nothing if there is none. */
  async function logout(token: string): Promise<void> {
    await prisma.session.deleteMany({ where: { tokenHash: hashToken(token) } });
  }

  return { login, getSession, logout };
}
