import { expect, type Page, test } from '@playwright/test';
import { DOMAINS, signIn } from './support';

// docs/platform/web-shell.md → Settings, labels, number series (PR c). On Demo Café, so the shell
// tests (pinned to Demo Bistro) see default labels. Each test leaves the organization as it found
// it, and copes with leftovers of an interrupted run.

/** Signs in as the Durby owner and makes Demo Café the active organization. */
async function onDemoCafe(page: Page): Promise<void> {
  await signIn(page, DOMAINS.durby, 'owner@durby.local');
  if ((await page.getByTestId('organization').textContent()) !== 'Demo Café') {
    await page.getByTestId('organization-switcher').click();
    await page.getByRole('menuitemradio', { name: 'Demo Café' }).click();
    await expect(page.getByTestId('organization')).toHaveText('Demo Café');
  }
}

test('change a setting, then use the inherited value again', async ({ page }) => {
  await onDemoCafe(page);
  await page.goto(`${DOMAINS.durby}/settings/general`);
  const setting = page.locator('[data-testid="setting"][data-key="inventory.allowNegativeStock"]');
  const source = setting.getByTestId('setting-source');
  await expect(source).toBeVisible();
  if ((await source.textContent()) === 'Set here') {
    await setting.getByTestId('setting-inherit').click();
    await expect(source).toHaveText('Inherited');
  }

  await setting.getByTestId('setting-value').click();
  await setting.getByTestId('setting-save').click();
  await expect(source).toHaveText('Set here');
  await expect(setting.getByTestId('setting-value')).toBeChecked();

  // Survives a reload: it was stored.
  await page.reload();
  await expect(source).toHaveText('Set here');

  await setting.getByTestId('setting-inherit').click();
  await expect(source).toHaveText('Inherited');
  await expect(setting.getByTestId('setting-value')).not.toBeChecked();
});

test('override a label and see it in the nav, then remove it', async ({ page }) => {
  const text = `Pantry ${Math.random().toString(36).slice(2, 7)}`;
  await onDemoCafe(page);
  const navItem = page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByTestId('nav-catalog');

  await page.goto(`${DOMAINS.durby}/settings/labels`);
  const row = page.locator('[data-testid="label-row"][data-key="catalog.nav.title"]').first();
  await row.getByTestId('label-value').fill(text);
  await expect(row.getByTestId('label-preview')).toContainText(text);
  await row.getByTestId('label-save').click();
  // The shell reloads its labels: no page reload needed.
  await expect(navItem).toHaveText(text);

  await row.getByTestId('label-remove').click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Remove' }).click();
  await expect(navItem).toHaveText('Products');
});

test('raise a number series counter by one', async ({ page }) => {
  await onDemoCafe(page);
  await page.goto(`${DOMAINS.durby}/settings/numbering`);
  const series = page.locator('[data-testid="number-series"][data-key="billing.invoice"]');
  const next = series.getByTestId('series-next-value');
  await expect(next).toHaveText(/^[0-9]+$/);
  const raised = (BigInt((await next.textContent()) ?? '1') + 1n).toString();

  await series.getByTestId('counter-value').fill(raised);
  await series.getByTestId('counter-raise').click();
  await expect(next).toHaveText(raised);
  await expect(series.getByTestId('series-preview')).toContainText(raised);
  // Counters only move forward: the reset policy is locked now.
  await expect(series.getByTestId('reset-locked')).toBeVisible();
});
