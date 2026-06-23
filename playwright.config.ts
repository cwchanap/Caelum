import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 30_000,
  retries: 2,
  use: {
    trace: "on-first-retry",
    baseURL: "http://127.0.0.1:5281",
  },
  webServer: {
    command: "bun run dev",
    url: "http://127.0.0.1:5281",
    reuseExistingServer: true,
    timeout: 60_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
