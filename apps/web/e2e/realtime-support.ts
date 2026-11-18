import { type Browser, expect, type Page } from '@playwright/test';
import { DOMAINS, signIn } from './support';

/** Berlin's date and wall-clock time now, the minutes rounded down to 5. */
export function berlinNow(): { date: string; time: string } {
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

/**
 * A tablet: its own browser context (own sign-in, own session). `slowPolling` stretches every
 * interval of 30 s or more a hundredfold, so the page can only learn of changes from its stream.
 */
export async function tablet(
  browser: Browser,
  email: string,
  { slowPolling = false } = {},
): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  if (slowPolling) {
    await page.addInitScript(() => {
      const setIntervalReal = window.setInterval.bind(window);
      window.setInterval = ((handler: TimerHandler, ms?: number, ...args: unknown[]) =>
        setIntervalReal(
          handler,
          typeof ms === 'number' && ms >= 30_000 ? ms * 100 : ms,
          ...args,
        )) as typeof window.setInterval;
    });
  }
  await signIn(page, DOMAINS.durby, email);
  return page;
}

/** + Booking on /host for 2 now (Book anyway outside the opening hours); returns its row. */
export async function bookNow(host: Page, guest: string) {
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
  const row = hostRow(host, guest);
  await expect(row).toHaveAttribute('data-status', 'booked');
  return row;
}

export const hostRow = (page: Page, guest: string) =>
  page.getByTestId('timeline-row').filter({ has: page.getByText(guest) });

/** A change on one tablet must show on another within this long (RT.1 acceptance). */
export const LIVE_WITHIN_MS = 2_000;
