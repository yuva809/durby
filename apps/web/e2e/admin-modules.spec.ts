import { expect, type Page, test } from '@playwright/test';
import { DEV_PASSWORD, DOMAINS, MAILPIT, uniqueEmail } from './support';

// docs/platform/admin-portal.md → Modules (step 1d): staff pick a customer's modules at onboarding
// and switch them later; the customer's navigation follows.

/** The local/CI staff super admin from seed-dev (DURBY_ALLOW_DEV_SEED=1). */
const STAFF = 'ops@durby.local';
const OWNER_PASSWORD = 'e2e-owner-password';

async function staffSignIn(page: Page): Promise<void> {
  await page.goto(`${DOMAINS.durby}/platform/login`);
  await page.getByLabel('Email').fill(STAFF);
  await page.getByLabel('Password', { exact: true }).fill(DEV_PASSWORD);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
}

/** The set-password link of the newest mail to `email` (Mailpit). */
async function setPasswordLink(page: Page, email: string): Promise<string> {
  let text = '';
  await expect
    .poll(
      async () => {
        const search = await page.request.get(`${MAILPIT}/api/v1/search`, {
          params: { query: `to:"${email}"` },
        });
        const first = ((await search.json()) as { messages: { ID: string }[] }).messages[0];
        if (!first) return '';
        const message = await page.request.get(`${MAILPIT}/api/v1/message/${first.ID}`);
        text = ((await message.json()) as { Text: string }).Text;
        return text;
      },
      { timeout: 15_000 },
    )
    .toContain('/reset-password#token=');
  return /(https?:\/\/\S+\/reset-password#token=\S+)/.exec(text)![1]!;
}

const box = (page: Page, scope: string, key: string) =>
  page.getByTestId(scope).getByTestId(`module-${key}`).getByRole('checkbox').first();

/** Saves the Modules card's pending changes with a reason. */
async function saveChanges(page: Page, reason: string): Promise<void> {
  await page.getByTestId('modules-review').click();
  const dialog = page.getByTestId('modules-dialog');
  await dialog.getByTestId('modules-reason').fill(reason);
  await dialog.getByTestId('modules-save').click();
  await expect(page.getByTestId('customer-modules')).toContainText('Modules saved.');
}

test('a customer gets exactly the modules staff pick, and later changes reach their menu', async ({
  page,
  browser,
}) => {
  const ownerEmail = uniqueEmail('modules');
  const name = `E2E Modules ${Date.now()}`;

  // Onboard on Full with Catalog + POS only.
  await staffSignIn(page);
  await page.goto(`${DOMAINS.durby}/platform/customers/new`);
  await page.getByTestId('onboard-name').fill(name);
  await page.getByTestId('onboard-email').fill(ownerEmail);
  const modules = page.getByTestId('onboard-modules');
  await expect(modules).toBeVisible();
  for (const key of [
    'inventory',
    'reservations',
    'billing',
    'reports',
    'api.public',
    'whitelabel',
  ]) {
    const checkbox = box(page, 'onboard-modules', key);
    if ((await checkbox.getAttribute('data-state')) === 'checked') await checkbox.click();
  }
  await expect(box(page, 'onboard-modules', 'catalog')).toHaveAttribute('data-state', 'checked');
  await expect(box(page, 'onboard-modules', 'pos')).toHaveAttribute('data-state', 'checked');
  await page.getByTestId('onboard-submit').click();
  await expect(page.getByTestId('onboard-done')).toBeVisible();
  await page.getByRole('link', { name: 'Open customer' }).click();
  await expect(page.getByTestId('customer-modules')).toBeVisible();
  const customerUrl = page.url();

  // The Owner sets a password and signs in: POS screens, no Inventory, no Reservations.
  const owner = await (await browser.newContext()).newPage();
  await owner.goto(await setPasswordLink(page, ownerEmail));
  await owner.getByLabel(/^New password/).fill(OWNER_PASSWORD);
  await owner.getByLabel('Repeat new password').fill(OWNER_PASSWORD);
  await owner.getByRole('button', { name: 'Set password' }).click();
  await owner.goto(`${DOMAINS.durby}/login`);
  await owner.getByLabel('Email').fill(ownerEmail);
  await owner.getByLabel('Password', { exact: true }).fill(OWNER_PASSWORD);
  await owner.getByRole('button', { name: 'Sign in' }).click();
  const nav = owner.getByRole('navigation', { name: 'Main navigation' });
  for (const id of ['catalog', 'service', 'kitchen', 'bar', 'tables']) {
    await expect(nav.getByTestId(`nav-${id}`)).toBeVisible();
  }
  for (const id of ['inventory', 'host', 'reservations']) {
    await expect(nav.getByTestId(`nav-${id}`)).toHaveCount(0);
  }

  // Staff switch Inventory on (back to Full's default): it appears in the Owner's menu.
  await page.goto(customerUrl);
  await box(page, 'customer-modules', 'inventory').click();
  await saveChanges(page, 'Customer bought inventory');
  await owner.reload();
  await expect(nav.getByTestId('nav-inventory')).toBeVisible();

  // "Reset to plan" on Reservations: Full includes it, so it comes back.
  await page.getByTestId('module-reset-reservations').click();
  await saveChanges(page, 'Back to the plan');
  await expect(page.getByTestId('module-reset-reservations')).toHaveCount(0);
  await owner.reload();
  await expect(nav.getByTestId('nav-host')).toBeVisible();
  await expect(nav.getByTestId('nav-reservations')).toBeVisible();
  await owner.context().close();
});
