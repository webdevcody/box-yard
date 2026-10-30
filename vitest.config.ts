import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Removes the temp folders each test file made (tmpDir in test/helpers.ts).
    setupFiles: ["test/setup.ts"],
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
})
