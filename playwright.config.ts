import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:3139",
    httpCredentials: { username: "day", password: "test" },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node --import tsx e2e/serve.ts",
    url: "http://127.0.0.1:3139/health",
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      ...process.env,
      DAY_PORT: "3139",
      DAY_PASSWORD: "test",
      DAY_READ_TOKEN: "test-token",
      DAY_NOW: "2026-09-25T09:30:00+02:00",
      DAY_BASE_URL: "http://127.0.0.1:3139",
    },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
