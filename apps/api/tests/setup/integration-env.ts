import { getTestDatabaseUrl } from "../helpers/test-db.js";

// Runs before every integration test file: point the app at the test database only.
process.env["DATABASE_URL"] = getTestDatabaseUrl();
process.env["NODE_ENV"] = "test";
process.env["LOG_LEVEL"] = "silent";
// The cheapest bcrypt setting, so tests that sign in many times stay fast.
process.env["BCRYPT_COST"] = "4";
// Tests must not call a real AI service, whatever is set in apps/api/.env. The Part 4 test that
// needs an AI sets its own (fake) service before it loads the app.
process.env["AI_PROVIDER"] = "none";
