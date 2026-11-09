import { defineConfig } from "vitest/config";

// Opt-in Docker tests: start throwaway containers and a throwaway volume, then delete them.
// They do not touch the development container or its volume.
// Run with `npm run test:docker -w @leaklens/api`.
export default defineConfig({
  test: {
    include: ["tests/docker/**/*.docker.test.ts"],
    environment: "node",
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
