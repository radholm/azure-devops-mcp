import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["**/*.{test,spec}.{ts,tsx,js,jsx}"],
    clearMocks: true,
    silent: true,
    coverage: {
      enabled: true,
      provider: "v8",
      reportsDirectory: "coverage",
      reporter: ["text", "lcov", "json-summary"],
      thresholds: {
        branches: 40,
        functions: 40,
        lines: 40,
        statements: 40,
      },
    },
    alias: {
      "^(.+)/version\\.js$": "$1/version.ts",
      "^(.+)/utils\\.js$": "$1/utils.ts",
      "^(.+)/auth\\.js$": "$1/auth.ts",
      "^(.+)/logger\\.js$": "$1/logger.ts",
      "^(.+)/elicitations\\.js$": "$1/elicitations.ts",
      "^(.+)/content-safety\\.js$": "$1/content-safety.ts",
    },
  },
  resolve: {
    alias: {
      "@modules": "./src/modules",
      "@tools": "./src/tools",
      "@config": "./src/config",
      "@utils": "./src/utils.ts",
    },
  },
});
