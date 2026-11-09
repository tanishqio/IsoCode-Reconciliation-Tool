import { getTestDatabaseUrl } from "../helpers/test-db.js";

// Runs before every integration test file: point the app at the test database only.
process.env["DATABASE_URL"] = getTestDatabaseUrl();
process.env["NODE_ENV"] = "test";
process.env["LOG_LEVEL"] = "silent";
