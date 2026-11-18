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
  projects: [
    { name: 'chromium', testIgnore: /api-restart\.spec\.ts/ },
    // Restarts the api: alone, after everything else (docs/platform/realtime.md → Tests).
    { name: 'api-restart', testMatch: /api-restart\.spec\.ts/, dependencies: ['chromium'] },
  ],
  webServer: [
    {
      // The built api under a small supervisor that can restart it (e2e/api-supervisor.ts).
      command: 'node --experimental-strip-types e2e/api-supervisor.ts',
      // A growing suite signs in many times from one IP: raise the auth rate limits for this run
      // only (ADR 0015 §14; production refuses values below the defaults), and send mail to
      // Mailpit. Applies when Playwright starts the api (CI); a dev api you started yourself
      // keeps its own values.
      env: {
        RATE_LIMIT_LOGIN_IP: '1000',
        RATE_LIMIT_LOGIN_EMAIL: '1000',
        RATE_LIMIT_REFRESH_IP: '1000',
        RATE_LIMIT_TOKEN_IP: '1000',
        // The specs read their mails from Mailpit: never send them through a real SMTP service a
        // local .env may point at.
        SMTP_URL: `smtp://localhost:${process.env.DURBY_SMTP_PORT ?? '1025'}`,
      },
      url: 'http://localhost:4000/api/v1/health/live',
      reuseExistingServer: !ci,
      timeout: 60_000,
    },
    {
      // The outbox worker (no HTTP server): the till's closed order finishes the booking
      // (reservations smoke). Ready once it logs that it started.
      command: 'pnpm --filter @durby/api exec node dist/worker.js',
      wait: { stdout: /outbox\.worker_started/ },
      env: { SMTP_URL: `smtp://localhost:${process.env.DURBY_SMTP_PORT ?? '1025'}` },
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
