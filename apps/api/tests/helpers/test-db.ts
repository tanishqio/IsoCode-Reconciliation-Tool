import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

export const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// The database name must contain "test", so these tests can never run against development data.
const SAFE_TEST_DB_NAME = /^[a-z0-9_]*test[a-z0-9_]*$/;

export function databaseNameOf(connectionString: string): string {
  return decodeURIComponent(new URL(connectionString).pathname.slice(1));
}

export function assertTestDatabase(connectionString: string | undefined): void {
  if (!connectionString) throw new Error("DATABASE_URL is not set for the test run.");
  const name = databaseNameOf(connectionString);
  if (!SAFE_TEST_DB_NAME.test(name)) {
    throw new Error(
      `Refusing to run: database "${name}" is not a test database (name must contain "test").`,
    );
  }
}

/**
 * The test database URL: TEST_DATABASE_URL if set, otherwise the DATABASE_URL in apps/api/.env
 * with the database name replaced by "leaklens_test".
 */
export function getTestDatabaseUrl(): string {
  const explicit = process.env["TEST_DATABASE_URL"];
  let url: URL;
  if (explicit) {
    url = new URL(explicit);
  } else {
    const envFile = path.join(apiRoot, ".env");
    if (!fs.existsSync(envFile)) {
      throw new Error(
        "apps/api/.env was not found. Copy .env.example to .env, or set TEST_DATABASE_URL.",
      );
    }
    const configured = dotenv.parse(fs.readFileSync(envFile))["DATABASE_URL"];
    if (!configured) throw new Error("DATABASE_URL is missing from apps/api/.env.");
    url = new URL(configured);
    url.pathname = "/leaklens_test";
  }
  const result = url.toString();
  assertTestDatabase(result);
  return result;
}
