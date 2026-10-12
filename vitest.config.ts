import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    setupFiles: ["./test/vitest.setup.ts"],
    unstubGlobals: true,
  },
});
