import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    setupFiles: ["test/setup-env.ts"],
    // Integration tests share one Postgres database and truncate between
    // cases, so test files must not run concurrently against it.
    fileParallelism: false,
  },
});
