import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    environment: "node",
    // Live-geometry parity tests (full turf joins on real fields) take 3-4s
    // alone and can exceed the 5s default under parallel worker load.
    testTimeout: 30_000,
  },
});
