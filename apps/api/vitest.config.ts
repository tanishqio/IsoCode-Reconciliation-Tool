import { defineConfig } from "vitest/config";

// Unit tests: no database and no Docker needed. Run with `npm run test -w @leaklens/api`.
export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
    // The first import of the app loads the large generated Prisma client, which can take a few seconds.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: {
      NODE_ENV: "test",
      LOG_LEVEL: "info",
      // Never connected to: unit tests must not touch a database.
      DATABASE_URL: "postgresql://unit:unit@localhost:5432/unit_never_connected",
    },
  },
});
