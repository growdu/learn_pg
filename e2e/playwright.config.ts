import { defineConfig, devices } from '@playwright/test'

/**
 * E2E test configuration for learn_pg.
 *
 * Test environment:
 *   - docker-compose.e2e.yml starts: postgres, backend, frontend
 *   - Backend: http://localhost:3010
 *   - Frontend (nginx): http://localhost:3001
 *
 * Design principles:
 *   - Tests target the frontend UI via Playwright browser automation
 *   - API calls go through the frontend (nginx proxy) when possible
 *   - Direct backend API calls for provisioning / discovery flows
 *   - Each test file is self-contained and can run independently
 */
export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
  ],

  use: {
    baseURL: `http://localhost:${process.env.PG_E2E_FE_PORT ?? '3001'}`,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 10_000,
  },

  projects: [
    // Desktop Chrome (use system chromium)
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        channel: undefined,
      },
      launchOptions: {
        executablePath: '/usr/bin/chromium-browser',
      },
    },
  ],

  webServer: {
    command: 'docker compose -f ../docker-compose.e2e.yml up --wait',
    url: `http://localhost:${process.env.PG_E2E_FE_PORT ?? '3001'}`,
    reuseExistingServer: true,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
