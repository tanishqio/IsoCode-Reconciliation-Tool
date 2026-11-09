import { defineConfig } from "vitest/config";

// Integration tests: need the Docker database to be running (`docker compose up -d db`).
// They use a separate database, "leaklens_test", created and migrated automatically,
// so the development data is never touched. Run with `npm run test:integration -w @leaklens/api`.
export default defineConfig({
  test: {
    include: ["tests/integration/**/*.integration.test.ts"],
    environment: "node",
    globalSetup: ["tests/setup/global-db.ts"],
    setupFiles: ["tests/setup/integration-env.ts"],
    // All files share one database, so run them one after another.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
