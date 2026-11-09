import { execFileSync } from "node:child_process";
import pg from "pg";
import { apiRoot, databaseNameOf, getTestDatabaseUrl } from "../helpers/test-db.js";

// Runs once before the integration tests: makes sure the test database exists and is migrated.
export default async function setup() {
  const testUrl = getTestDatabaseUrl();
  const dbName = databaseNameOf(testUrl); // validated: lowercase letters, digits, underscores

  const admin = new URL(testUrl);
  admin.pathname = "/postgres";
  const client = new pg.Client({
    connectionString: admin.toString(),
    connectionTimeoutMillis: 5000,
  });
  try {
    await client.connect();
  } catch (cause) {
    throw new Error(
      "Cannot reach PostgreSQL. Start Docker Desktop and run `docker compose up -d db`, then try again.",
      { cause },
    );
  }
  try {
    const found = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
    if (found.rowCount === 0) await client.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await client.end();
  }

  try {
    execFileSync("npx", ["prisma", "migrate", "deploy"], {
      cwd: apiRoot,
      env: { ...process.env, DATABASE_URL: testUrl },
      stdio: "pipe",
      shell: true, // needed to run npx on Windows; the arguments are fixed, not user input
    });
  } catch (err) {
    const e = err as { stdout?: Buffer; stderr?: Buffer };
    throw new Error(
      `prisma migrate deploy failed on the test database:\n${String(e.stdout ?? "")}${String(e.stderr ?? "")}`,
      { cause: err },
    );
  }
}
