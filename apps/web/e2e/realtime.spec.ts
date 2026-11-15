import { expect, test } from '@playwright/test';
import { DOMAINS } from './support';
import { bookNow, hostRow, LIVE_WITHIN_MS, tablet } from './realtime-support';

/**
 * RT.1 (docs/platform/realtime.md, ADR 0044): a change on one tablet shows on another within 2 s
 * through the reservations stream (outbox → worker → Redis → stream → reload). The watching tablet's
 * polling is slowed a hundredfold, so only the stream can tell it.
 */
test('a booking and its seating show on a second tablet within 2 s', async ({ browser }) => {
  test.setTimeout(60_000);
  const guest = `Live ${Date.now()}`;
  const watching = await tablet(browser, 'host@durby.local', { slowPolling: true });
  const live = watching.waitForResponse(
    (r) => r.url().includes('/api/v1/reservations/stream') && r.status() === 200,
  );
  await watching.goto(`${DOMAINS.durby}/host`);
  await live;
  await expect(watching.getByTestId('host-counts')).toBeVisible();

  const acting = await tablet(browser, 'host@durby.local');
  await acting.goto(`${DOMAINS.durby}/host`);
  const row = await bookNow(acting, guest);
  await expect(hostRow(watching, guest)).toHaveAttribute('data-status', 'booked', {
    timeout: LIVE_WITHIN_MS,
  });

  await row.getByTestId('row-seat').click();
  await expect(row).toHaveAttribute('data-status', 'seated');
  await expect(hostRow(watching, guest)).toHaveAttribute('data-status', 'seated', {
    timeout: LIVE_WITHIN_MS,
  });
});
