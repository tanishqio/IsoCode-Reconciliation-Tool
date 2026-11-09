import { Router, type RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { AppError } from "../../lib/errors.js";
import { isPasswordLengthOk } from "../../lib/passwords.js";
import { clearSessionCookie, sessionCookieOptions } from "./auth.middleware.js";
import type { AuthService } from "./auth.service.js";
import { SESSION_COOKIE, type AuthedRequest } from "./auth.types.js";

const loginBodySchema = z.strictObject({
  email: z.string().trim().toLowerCase().min(1).max(254),
  password: z.string().min(1).max(200).refine(isPasswordLengthOk, "The password is too long."),
});

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

/**
 * Limits failed sign-in attempts per IP address. Successful sign-ins are not counted, so a team
 * behind one office address is not locked out by a single mistyped password.
 */
export function createLoginRateLimiter(max: number): RequestHandler {
  return rateLimit({
    windowMs: FIFTEEN_MINUTES_MS,
    limit: max,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    handler: (_req, _res, next) => {
      next(
        new AppError("RATE_LIMITED", 429, "Too many sign-in attempts. Try again in a few minutes."),
      );
    },
  });
}

export interface AuthRouterOptions {
  service: AuthService;
  authenticate: RequestHandler;
  csrfProtection: RequestHandler;
  loginRateLimiter: RequestHandler;
  sessionTtlMs: number;
}

export function createAuthRouter({
  service,
  authenticate,
  csrfProtection,
  loginRateLimiter,
  sessionTtlMs,
}: AuthRouterOptions): Router {
  const router = Router();

  // Nothing here may be cached by the browser or a proxy: it is per-user.
  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  router.post("/login", loginRateLimiter, async (req, res) => {
    const body = loginBodySchema.parse(req.body);
    const result = await service.login(body);
    res.cookie(SESSION_COOKIE, result.token, sessionCookieOptions(sessionTtlMs));
    res.json({ user: result.user, csrfToken: result.csrfToken });
  });

  router.get("/me", authenticate, (req, res) => {
    const session = (req as AuthedRequest).authSession;
    if (!session) throw new AppError("UNAUTHENTICATED", 401, "Please sign in.");
    res.json({ user: session.user, csrfToken: session.csrfToken });
  });

  router.post("/logout", authenticate, csrfProtection, async (req, res) => {
    const token = (req as AuthedRequest).cookies?.[SESSION_COOKIE];
    if (typeof token === "string") await service.logout(token);
    clearSessionCookie(res);
    res.status(204).end();
  });

  return router;
}
