import pino, { type DestinationStream, type Level, type LevelWithSilent } from "pino";
import { env } from "../config/env.js";

const redactPaths = [
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  // Top-level fields, and fields one level down. "*.x" alone does not match a top-level "x".
  "password",
  "passwordHash",
  "token",
  "csrfToken",
  "*.password",
  "*.passwordHash",
  "*.token",
  "*.csrfToken",
];

/** Builds a logger. The destination and level are only overridden by tests. */
export function createLogger(destination?: DestinationStream, level?: Level | LevelWithSilent) {
  return pino(
    {
      level: level ?? (env.NODE_ENV === "test" ? "silent" : env.LOG_LEVEL),
      redact: { paths: redactPaths, censor: "[redacted]" },
    },
    destination,
  );
}

export const logger = createLogger();
