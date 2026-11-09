import type { CookieOptions, RequestHandler, Response } from "express";
import { env } from "../../config/env.js";
import { AppError } from "../../lib/errors.js";
import type { AuthService } from "./auth.service.js";
import { CSRF_HEADER, SESSION_COOKIE, type AuthedRequest } from "./auth.types.js";
import { safeEqual } from "./tokens.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Cookie settings. HttpOnly keeps the token away from page scripts, SameSite=Lax stops the browser
 * sending it on cross-site form posts, and Secure (production only) keeps it off plain HTTP.
 */
export function sessionCookieOptions(maxAgeMs?: number): CookieOptions {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: env.NODE_ENV === "production",
    path: "/",
    ...(maxAgeMs === undefined ? {} : { maxAge: maxAgeMs }),
  };
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, sessionCookieOptions());
}

export function createAuthMiddleware({ service }: { service: AuthService }) {
  /** Requires a valid session. Sets req.user = { id, role } for the role check and the controllers. */
  const authenticate: RequestHandler = async (req, res, next) => {
    const token = (req as AuthedRequest).cookies?.[SESSION_COOKIE];
    if (typeof token !== "string" || token === "") {
      next(new AppError("UNAUTHENTICATED", 401, "Please sign in."));
      return;
    }

    const session = await service.getSession(token);
    if (!session) {
      clearSessionCookie(res);
      next(new AppError("UNAUTHENTICATED", 401, "Your session has ended. Please sign in again."));
      return;
    }

    const authed = req as AuthedRequest;
    authed.authSession = session;
    authed.user = { id: session.user.id, role: session.user.role };
    next();
  };

  /**
   * Cross-site request forgery check. Requests that change data must send the CSRF token from
   * sign-in / "who am I" in the X-CSRF-Token header. Reads are not checked. Run after authenticate.
   */
  const csrfProtection: RequestHandler = (req, _res, next) => {
    if (SAFE_METHODS.has(req.method)) {
      next();
      return;
    }
    const expected = (req as AuthedRequest).authSession?.csrfToken;
    const sent = req.get(CSRF_HEADER);
    if (!expected || typeof sent !== "string" || !safeEqual(sent, expected)) {
      next(
        new AppError(
          "FORBIDDEN",
          403,
          "The request could not be verified. Reload the page and try again.",
        ),
      );
      return;
    }
    next();
  };

  return { authenticate, csrfProtection };
}
