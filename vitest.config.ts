import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    teardownTimeout: 10_000,
    pool: "threads",
    poolOptions: {
      threads: {
        singleThread: true,
      },
    },
    globals: true,
    setupFiles: ["src/test/setup.ts"],
  },
});
