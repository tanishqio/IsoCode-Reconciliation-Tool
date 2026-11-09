import type { RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import { AppError } from "../lib/errors.js";

const ONE_MINUTE_MS = 60_000;

/**
 * A general brake on how many API requests one IP address can make per minute. It protects the
 * server from a runaway script or a simple flood; the sign-in route has its own, stricter limit.
 * The counts live in this process's memory, so they reset on restart and are not shared between
 * several API copies. Behind a proxy, set Express's `trust proxy` so the real address is used.
 */
export function createApiRateLimiter(maxPerMinute: number): RequestHandler {
  return rateLimit({
    windowMs: ONE_MINUTE_MS,
    limit: maxPerMinute,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: (_req, _res, next) => {
      next(new AppError("RATE_LIMITED", 429, "Too many requests. Please slow down and try again."));
    },
  });
}
