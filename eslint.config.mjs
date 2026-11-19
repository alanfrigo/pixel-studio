import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    ".next/**", "out/**", "build/**", "next-env.d.ts", "plan/**", "data/**", "schemas/**", "fixtures/**",
    ".taste-skill/**", "public/assets/{effects,moments,motion}/**",
    "coverage/**", "playwright-report/**", "test-results/**", "python/.venv/**",
  ]),
]);
