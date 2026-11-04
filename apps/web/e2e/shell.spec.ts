import { expect, test } from '@playwright/test';
import { DOMAINS, signIn, token } from './support';

// The step's "done when": two demo organizations on two domains look different, see different
// modules and show different labels (docs/platform/web-shell.md).

test.describe('default partner domain', () => {
  test('Durby theme, all modules of the full plan, default labels', async ({ page }) => {
    await page.goto(`${DOMAINS.durby}/login`);
    await expect(page).toHaveTitle('Durby');
    await expect(page.getByTestId('wordmark')).toHaveText('Durby');
    expect(await token(page, 'primary')).toBe('#ff5a1f');

    await signIn(page, DOMAINS.durby, 'owner@durby.local');
    const nav = page.getByRole('navigation', { name: 'Main navigation' });

    // owner@durby.local belongs to two organizations; pin the one without label overrides.
    const switcher = page.getByTestId('organization-switcher');
    await expect(switcher).toBeVisible();
    if ((await page.getByTestId('organization').textContent()) !== 'Demo Bistro') {
      await switcher.click();
      await page.getByRole('menuitemradio', { name: 'Demo Bistro' }).click();
      await expect(page.getByTestId('organization')).toHaveText('Demo Bistro');
    }
    await switcher.click();
    await expect(page.getByRole('menuitemradio')).toHaveText(['Demo Bistro', 'Demo Café']);
    await page.keyboard.press('Escape');

    for (const id of ['inventory', 'catalog', 'service', 'tables', 'settings']) {
      await expect(nav.getByTestId(`nav-${id}`)).toBeVisible();
    }
    // Modules not built yet stay out of the menu (their pages still open by URL).
    for (const id of ['billing', 'pos', 'reports']) {
      await expect(nav.getByTestId(`nav-${id}`)).toHaveCount(0);
    }
  });
});

test.describe('demo partner domain', () => {
  test('demo theme, only the inventory plan, partner labels', async ({ page }) => {
    await page.goto(`${DOMAINS.demo}/login`);
    await expect(page).toHaveTitle('Gastro Demo');
    await expect(page.getByTestId('wordmark')).toHaveText('Gastro Demo');
    expect(await token(page, 'primary')).toBe('#0f766e');
    expect(await token(page, 'background')).toBe('#f4f8f8');

    await signIn(page, DOMAINS.demo, 'owner@partner-demo.local');
    const nav = page.getByRole('navigation', { name: 'Main navigation' });
    await expect(nav.getByTestId('nav-catalog')).toBeVisible();
    // The inventory plan has no pos feature: no Service or Tables.
    await expect(nav.getByTestId('nav-service')).toHaveCount(0);
    await expect(nav.getByTestId('nav-tables')).toHaveCount(0);
    // Partner terminology: the inventory plan's module under the partner's name.
    await expect(nav.getByTestId('nav-inventory')).toContainText('Stock');
    // One organization: its name, no switcher; the Durby organizations stay invisible.
    await expect(page.getByTestId('organization')).toHaveText('Demo Trattoria');
    await expect(page.getByTestId('organization-switcher')).toHaveCount(0);

    await page.goto(`${DOMAINS.demo}/billing`);
    await expect(page.getByTestId('module-notAvailable')).toBeVisible();
    // Partner terminology: the inventory page carries the partner's label.
    await page.goto(`${DOMAINS.demo}/inventory`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Stock');

    // Sign out returns to the login page of the same domain, and the session is gone.
    await page.getByRole('button', { name: 'Account menu' }).click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(`${DOMAINS.demo}/login`);
    await page.goto(`${DOMAINS.demo}/`);
    await expect(page).toHaveURL(`${DOMAINS.demo}/login`);
  });
});

test('signed-out visitors go to the themed login and come back after signing in', async ({
  page,
}) => {
  await page.goto(`${DOMAINS.demo}/inventory`);
  await expect(page).toHaveURL(`${DOMAINS.demo}/login?next=%2Finventory`);
  await expect(page.getByTestId('wordmark')).toHaveText('Gastro Demo');
  await page.getByLabel('Email').fill('owner@partner-demo.local');
  await page.getByLabel('Password', { exact: true }).fill('durby-dev-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(`${DOMAINS.demo}/inventory`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Stock');
});

// Back office on an iPad: drawer navigation, touch, keyboard basics. One sign-in per test keeps the
// suite under the login rate limit (docs/platform/auth.md → Abuse protection: 10 per email per 15 min).
test.describe('tablet', () => {
  test.use({ viewport: { width: 820, height: 1180 }, hasTouch: true });

  test('drawer navigation and the skip link', async ({ page }) => {
    await signIn(page, DOMAINS.demo, 'owner@partner-demo.local');
    const nav = page.getByRole('navigation', { name: 'Main navigation' });
    await expect(nav).toHaveCount(0);
    await page.getByRole('button', { name: 'Open menu' }).click();
    await nav.getByTestId('nav-catalog').click();
    await expect(page).toHaveURL(`${DOMAINS.demo}/catalog`);
    await expect(nav).toHaveCount(0);

    // From a fresh page load, the first Tab reaches the skip link, which moves focus to <main>.
    await page.reload();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Products');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#main')).toBeFocused();
  });
});
