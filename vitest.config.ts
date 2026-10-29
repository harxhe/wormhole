import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["{protocol,transport,server,inspector,client,dashboard}/test/**/*.test.ts"],
    testTimeout: 15000,
    hookTimeout: 15000,
    env: {
      WORMHOLE_LOG_LEVEL: "error"
    }
  }
});
