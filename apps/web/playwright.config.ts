import { defineConfig, devices } from '@playwright/test';

/**
 * Smoke suite against the local stack (docs/platform/web-shell.md → Tests): Postgres, Redis and
 * Mailpit from docker-compose.yml, migrations and `seed-dev` applied. Starts the built api and web
 * unless they already run (local dev). Two domains via *.localhost, which Chromium resolves to
 * loopback.
 */
const ci = Boolean(process.env.CI);

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: ci,
  retries: ci ? 1 : 0,
  reporter: ci ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    ...devices['Desktop Chrome'],
    viewport: { width: 1280, height: 800 },
    trace: 'retain-on-failure',
    // Optional locally, e.g. PLAYWRIGHT_CHANNEL=chrome to use an installed Chrome instead of
    // downloading Playwright's Chromium. CI uses Playwright's Chromium.
    ...(process.env.PLAYWRIGHT_CHANNEL && { channel: process.env.PLAYWRIGHT_CHANNEL }),
  },
  projects: [{ name: 'chromium' }],
  webServer: [
    {
      command: 'pnpm --filter @durby/api start',
      url: 'http://localhost:4000/api/v1/health/live',
      reuseExistingServer: !ci,
      timeout: 60_000,
    },
    {
      command: 'pnpm --filter @durby/web start',
      url: 'http://localhost:3000/healthz',
      reuseExistingServer: !ci,
      timeout: 60_000,
    },
  ],
});
