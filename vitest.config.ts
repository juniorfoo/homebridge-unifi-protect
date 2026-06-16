import { defineConfig } from "vitest/config";

export default defineConfig({

  test: {

    environment: "node",
    include: [ "test/**/*.test.ts" ],
    setupFiles: [ "test/setup.ts" ],
    coverage: {

      provider: "v8",
      include: [ "src/**/*.ts" ],
      exclude: [ "src/**/*.d.ts" ],
      reporter: [ "text", "text-summary", "lcov" ],
      thresholds: {

        lines: 95,
        functions: 95,
        branches: 95,
        statements: 95
      }
    }
  }
});
