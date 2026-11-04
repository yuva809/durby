import { type Browser, expect, type Page, test } from '@playwright/test';
import { DOMAINS, signIn } from './support';

/**
 * The host flow end to end (docs/modules/reservations.md → R1.9): the host books, marks arrived,
 * seats, undoes and seats again; the waiter sees the booking on /service with its guests
 * pre-filled, sends a ticket and closes the order; the outbox worker finishes the booking, and
 * /host shows "Finished at the till". Demo Bistro (seed-dev, plan full), Europe/Berlin.
 */

/** Berlin's date and wall-clock time now, the minutes rounded down to 5 (a start never > 15 min ago). */
function berlinNow(): { date: string; time: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Berlin',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value]),
  );
  const minute = String(Math.floor(Number(parts.minute) / 5) * 5).padStart(2, '0');
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${minute}` };
}

async function as(browser: Browser, email: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  // Sending a ticket prints it: no print dialog in a headless run.
  await page.addInitScript(() => {
    window.print = () => undefined;
  });
  await signIn(page, DOMAINS.durby, email);
  return page;
}

test('book, arrive, seat, undo, seat; the till closes the order and finishes the booking', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const guest = `Smoke ${Date.now()}`;
  const host = await as(browser, 'host@durby.local');
  await host.goto(`${DOMAINS.durby}/host`);

  // + Booking now, for 2; the system picks the table. Outside the opening hours: Book anyway.
  await host.getByTestId('host-new-booking').click();
  const dialog = host.getByTestId('booking-dialog');
  const { date, time } = berlinNow();
  await dialog.getByLabel('Date').fill(date);
  await dialog.getByLabel('Time').fill(time);
  await dialog.getByLabel('Name').fill(guest);
  await dialog.getByTestId('booking-dialog-submit').click();
  const force = dialog.getByTestId('booking-force');
  await Promise.race([
    dialog.waitFor({ state: 'hidden' }),
    force.waitFor({ state: 'visible' }).then(() => force.click()),
  ]);
  await expect(dialog).toBeHidden();

  const row = host.getByTestId('timeline-row').filter({ has: host.getByText(guest) });
  await expect(row).toHaveAttribute('data-status', 'booked');
  const table = (await row.getAttribute('data-tables'))?.split(',')[0] ?? '';
  expect(table).not.toBe('');

  await row.getByTestId('row-arrive').click();
  await expect(row).toHaveAttribute('data-status', 'arrived');
  await row.getByTestId('row-seat').click();
  await expect(row).toHaveAttribute('data-status', 'seated');
  await host.getByTestId('undo-bar-undo').click();
  await expect(row).toHaveAttribute('data-status', 'arrived');
  await row.getByTestId('row-seat').click();
  await expect(row).toHaveAttribute('data-status', 'seated');

  // The waiter's floor shows the seated booking; the till pre-fills its guests.
  const waiter = await as(browser, 'waiter@durby.local');
  await waiter.goto(`${DOMAINS.durby}/service`);
  const tile = waiter.locator(`[data-testid="floor-table"][data-name="${table}"]`);
  await expect(tile.getByTestId('floor-booking')).toContainText('From booking');
  await tile.getByRole('link').click();
  await expect(waiter.getByTestId('guests-value')).toHaveText('2');
  await waiter.getByTestId('menu-product').first().click();
  await waiter.getByTestId('send-to-kitchen').click();
  await waiter.getByTestId('close-order').click();
  await waiter.getByRole('alertdialog').getByRole('button', { name: 'Close order' }).click();
  await expect(waiter.getByTestId('close-order')).toBeHidden();

  // The worker handles pos.order.closed: the booking is finished, by the till.
  await expect
    .poll(
      async () => {
        await host.reload();
        return row.getAttribute('data-status');
      },
      { timeout: 45_000, intervals: [1_000, 2_000, 3_000] },
    )
    .toBe('finished');
  await expect(row.getByTestId('till-badge')).toHaveText('Finished at the till');
});
