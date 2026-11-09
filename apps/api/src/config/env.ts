import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// apps/api, so relative folder settings do not depend on where the server was started from.
const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
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
