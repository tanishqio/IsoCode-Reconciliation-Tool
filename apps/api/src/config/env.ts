import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// apps/api, so relative folder settings do not depend on where the server was started from.
const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    DATABASE_URL: z
      .string()
      .min(1, "is required")
      .refine((value) => /^postgres(ql)?:\/\//.test(value), "must start with postgresql://"),

    // Part 2: file upload. Folders are resolved against apps/api. Keep both on the same disk
    // so moving a file from the temp folder to permanent storage is a fast rename.
    UPLOAD_DIR: z
      .string()
      .min(1)
      .default("storage/uploads")
      .transform((value) => path.resolve(apiRoot, value)),
    UPLOAD_TEMP_DIR: z
      .string()
      .min(1)
      .default("storage/tmp")
      .transform((value) => path.resolve(apiRoot, value)),
    MAX_UPLOAD_FILE_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(50 * 1024 * 1024),
    MAX_UPLOAD_FILES: z.coerce.number().int().min(1).max(5).default(5),

    // Background worker (src/worker.ts). All times are in milliseconds.
    WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(50).default(2000),
    WORKER_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(50).default(5000),
    WORKER_STALE_AFTER_MS: z.coerce.number().int().min(1000).default(60_000),

    // Part 1: sign-in.
    SESSION_TTL_HOURS: z.coerce
      .number()
      .int()
      .min(1)
      .max(24 * 30)
      .default(12),
    // After this many wrong passwords in a row the account is locked for LOGIN_LOCK_MINUTES.
    LOGIN_MAX_FAILED_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(5),
    LOGIN_LOCK_MINUTES: z.coerce
      .number()
      .int()
      .min(1)
      .max(24 * 60)
      .default(15),
    // Failed sign-in attempts allowed per IP address in 15 minutes (separate from the lock above).
    LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(10_000).default(20),
    // Part 4: the AI that proposes column mappings. "none" = rule-based suggestions only.
    AI_PROVIDER: z.enum(["none", "openai-compatible"]).default("none"),
    AI_API_KEY: z.string().min(1).optional(),
    AI_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
    AI_MODEL: z.string().min(1).default("gpt-4o-mini"),
    AI_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(20_000),

    // bcrypt work factor. 12 is a sensible default; tests use 4 to stay fast.
    BCRYPT_COST: z.coerce.number().int().min(4).max(15).default(12),
  })
  .refine((value) => value.AI_PROVIDER === "none" || value.AI_API_KEY !== undefined, {
    path: ["AI_API_KEY"],
    message: "is required when AI_PROVIDER is not none",
  })
  .refine((value) => value.WORKER_STALE_AFTER_MS >= value.WORKER_HEARTBEAT_INTERVAL_MS * 3, {
    // Otherwise a healthy running job could be failed as stale between two heartbeats.
    path: ["WORKER_STALE_AFTER_MS"],
    message: "must be at least 3 times WORKER_HEARTBEAT_INTERVAL_MS",
  });

export type Env = z.infer<typeof schema>;

function loadEnv(): Env {
  const result = schema.safeParse(process.env);
  if (result.success) return result.data;

  // Print variable names and reasons only. Never print the values (they can contain secrets).
  const lines = result.error.issues.map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`);
  console.error(`Invalid environment configuration:\n${lines.join("\n")}`);
  console.error("Copy apps/api/.env.example to apps/api/.env and fill in the values.");
  process.exit(1);
}

export const env = loadEnv();
