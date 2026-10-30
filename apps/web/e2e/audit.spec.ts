import { expect, type Page, test } from '@playwright/test';
import { accept, DOMAINS, invitationLink, invite, signIn, uniqueEmail } from './support';

// docs/platform/web-shell.md → Audit log viewer (PR d). Changes the organization `locale` setting
// of Demo Bistro (only emails use it; the shell tests read labels, which it doesn't affect) and
// puts it back. The settings spec works on Demo Café.

async function onDemoBistro(page: Page): Promise<void> {
  await signIn(page, DOMAINS.durby, 'owner@durby.local');
  if ((await page.getByTestId('organization').textContent()) !== 'Demo Bistro') {
    await page.getByTestId('organization-switcher').click();
    await page.getByRole('menuitemradio', { name: 'Demo Bistro' }).click();
    await expect(page.getByTestId('organization')).toHaveText('Demo Bistro');
  }
}

test('a changed setting shows in the audit log with its before and after values', async ({
  page,
}) => {
  await onDemoBistro(page);
  await page.goto(`${DOMAINS.durby}/settings/general`);
  const locale = page.locator('[data-testid="setting"][data-key="locale"]');
  const source = locale.getByTestId('setting-source');
  await expect(source).toBeVisible();
  if ((await source.textContent()) === 'Set here') {
    await locale.getByTestId('setting-inherit').click();
    await expect(source).toHaveText('Inherited');
  }
  // Set (created), then change (updated): the update has both sides.
  await locale.getByTestId('setting-value').selectOption('de');
  await locale.getByTestId('setting-save').click();
  await expect(source).toHaveText('Set here');
  await locale.getByTestId('setting-value').selectOption('en');
  await locale.getByTestId('setting-save').click();
  await expect(locale.getByTestId('setting-save')).toBeDisabled();

  await page.goto(`${DOMAINS.durby}/audit?entityType=setting_value`);
  const entry = page.getByTestId('audit-entry').first();
  await expect(entry.getByTestId('audit-what')).toHaveText('Setting changed');
  await expect(entry.getByTestId('audit-who')).toHaveText('owner@durby.local');
  const value = entry.locator('[data-testid="audit-diff-row"][data-field="value"]');
  await expect(value.getByTestId('audit-before')).toContainText('de');
  await expect(value.getByTestId('audit-after')).toContainText('en');
  await expect(value).toHaveAttribute('data-changed', 'true');
  // The filter is in the URL: a reload shows the same view.
  await page.reload();
  await expect(page.getByTestId('filter-entity')).toHaveValue('setting_value');

  // Put it back.
  await page.goto(`${DOMAINS.durby}/settings/general`);
  await locale.getByTestId('setting-inherit').click();
  await expect(source).toHaveText('Inherited');
});

test('a Manager has no audit log in the menu and gets "no access"', async ({
  page,
  browser,
  request,
}) => {
  const email = uniqueEmail('manager-audit');
  await signIn(page, DOMAINS.durby, 'owner@durby.local');
  await invite(page, DOMAINS.durby, email, 'Manager');
  const manager = await accept(browser, await invitationLink(request, email));
  const origin = new URL(manager.url()).origin;
  await manager.goto(`${origin}/settings/organization`);
  const nav = manager.getByRole('navigation', { name: 'Main navigation' });
  await expect(nav.getByTestId('nav-settings')).toBeVisible();
  await expect(nav.getByTestId('nav-audit')).toHaveCount(0);
  await manager.goto(`${origin}/audit`);
  await expect(manager.getByTestId('no-access')).toBeVisible();
  await manager.context().close();
});
