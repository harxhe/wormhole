import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["{protocol,server,client}/test/**/*.test.ts"],
    testTimeout: 15000,
    hookTimeout: 15000
  }
});
