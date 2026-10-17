import { defineConfig } from "vitest/config";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    include: [path.resolve(__dirname, "../src/**/*.test.ts")],
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
    setupFiles: [path.resolve(__dirname, "../src/test/setup.ts")],
  },
});
