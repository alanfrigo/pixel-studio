import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.PLAYWRIGHT_PORT ?? 14831);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./e2e",
  forbidOnly: Boolean(process.env.CI),
  timeout: 45_000,
  reporter: process.env.CI ? [["line"], ["html", { open: "never" }]] : "list",
  use: { baseURL, locale: "en-US", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node --import tsx scripts/e2e-server.ts",
    env: { PORT: String(port), NEXT_TELEMETRY_DISABLED: "1" },
    url: `${baseURL}/api/v1/health`,
    timeout: 30_000,
    reuseExistingServer: false,
    gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
  },
});
