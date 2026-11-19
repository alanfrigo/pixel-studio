import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}", "scripts/**/*.ts"],
      exclude: ["**/*.test.{ts,tsx}"],
      reporter: ["text-summary", "html", "json-summary"],
      thresholds: {
        statements: 60,
        branches: 49,
        functions: 58,
        lines: 63,
        "src/app/**": { statements: 19, branches: 17, functions: 13, lines: 20 },
        "src/contracts/**": { statements: 84, branches: 75, functions: 98, lines: 87 },
        "src/domain/**": { statements: 92, branches: 80, functions: 97, lines: 94 },
        "src/server/**": { statements: 87, branches: 71, functions: 90, lines: 92 },
      },
    },
  },
});
