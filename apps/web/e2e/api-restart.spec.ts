import { expect, test } from '@playwright/test';
import { DOMAINS } from './support';
import { bookNow, hostRow, LIVE_WITHIN_MS, tablet } from './realtime-support';

/**
 * RT.1 (docs/platform/realtime.md → Tests): the api restarts (a deploy) while /host has its stream
 * open. The page reconnects by itself, reloads (it may have missed changes) and is live again,
 * without a page refresh. Runs alone in its own project, after the others: it stops the api.
 */
const SUPERVISOR = `http://127.0.0.1:${process.env.API_SUPERVISOR_PORT ?? 4999}`;

test('after an api restart the open page reconnects and reloads without a refresh', async ({
  browser,
  request,
}) => {
  test.setTimeout(120_000);
  const reachable = await request
    .get(`${SUPERVISOR}/`)
    .then(() => true)
    .catch(() => false);
  // Locally a dev api you started yourself has no supervisor; CI always has one.
  test.skip(!reachable && !process.env.CI, 'the api runs without e2e/api-supervisor.ts');

  const watching = await tablet(browser, 'host@durby.local', { slowPolling: true });
  const streams: string[] = [];
  const floors: number[] = [];
  watching.on('request', (r) => {
    if (r.url().includes('/api/v1/reservations/stream')) streams.push(r.url());
    if (r.url().includes('/api/v1/reservations/floor')) floors.push(Date.now());
  });
  const live = watching.waitForResponse(
    (r) => r.url().includes('/api/v1/reservations/stream') && r.status() === 200,
  );
  await watching.goto(`${DOMAINS.durby}/host`);
  await live;
  await expect(watching.getByTestId('host-counts')).toBeVisible();
  // Survives only if the page is never reloaded.
  await watching.evaluate(() => {
    (window as unknown as { rtMarker: string }).rtMarker = 'same page';
  });
  const streamsBefore = streams.length;

  const restarted = await request.post(`${SUPERVISOR}/restart`, { timeout: 90_000 });
  expect(restarted.status()).toBe(200);
  const backAt = Date.now();

  // Reconnects (backoff at most 30 s) and reloads on `ready`.
  await expect.poll(() => streams.length, { timeout: 45_000 }).toBeGreaterThan(streamsBefore);
  await expect
    .poll(() => floors.filter((t) => t >= backAt).length, { timeout: 45_000 })
    .toBeGreaterThan(0);
  expect(await watching.evaluate(() => (window as unknown as { rtMarker?: string }).rtMarker)).toBe(
    'same page',
  );

  // Live again: another tablet's booking shows within 2 s.
  const acting = await tablet(browser, 'host@durby.local');
  await acting.goto(`${DOMAINS.durby}/host`);
  const guest = `Restart ${Date.now()}`;
  await bookNow(acting, guest);
  await expect(hostRow(watching, guest)).toHaveAttribute('data-status', 'booked', {
    timeout: LIVE_WITHIN_MS,
  });
});
