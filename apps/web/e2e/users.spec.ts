import { expect, test } from '@playwright/test';
import { accept, DOMAINS, invitationLink, invite, signIn, uniqueEmail } from './support';

// docs/platform/web-shell.md → Users, roles, invitations (PR b).

test.describe('invitations', () => {
  test('an Owner invites a Manager; the link signs them up; they appear as Manager', async ({
    page,
    browser,
    request,
  }) => {
    const email = uniqueEmail('manager');
    await signIn(page, DOMAINS.durby, 'owner@durby.local');
    const organization = await page.getByTestId('organization').textContent();
    await invite(page, DOMAINS.durby, email, 'Manager');

    // Durby organizations have no partner domain: the link uses WEB_BASE_URL.
    const link = await invitationLink(request, email);
    expect(link.pathname).toBe('/accept-invite');
    await (await accept(browser, link)).context().close();

    await page.reload();
    await expect(page.getByTestId('organization')).toHaveText(organization ?? '');
    const row = page.getByTestId('member-row').filter({ hasText: email });
    await expect(row.getByTestId('member-role')).toHaveText('Manager');
    // The invitation is used up.
    await page.getByTestId('tab-invitations').click();
    await expect(page.getByTestId('invitation-row').filter({ hasText: email })).toHaveCount(0);
  });

  test("a demo-partner organization's invitation opens on the demo domain", async ({
    page,
    browser,
    request,
  }) => {
    const email = uniqueEmail('demo');
    await signIn(page, DOMAINS.demo, 'owner@partner-demo.local');
    await invite(page, DOMAINS.demo, email, 'Staff');

    const link = await invitationLink(request, email);
    expect(link.origin).toBe(DOMAINS.demo);
    await (await accept(browser, link)).context().close();

    await page.reload();
    const row = page.getByTestId('member-row').filter({ hasText: email });
    await expect(row.getByTestId('member-role')).toHaveText('Staff');
  });
});

test.describe('access', () => {
  // A Staff member made by the test itself: independent of what local dev data says about the
  // seeded users' roles.
  test("Staff sees neither Members nor Roles and can't open the pages", async ({
    page,
    browser,
    request,
  }) => {
    const email = uniqueEmail('staff');
    await signIn(page, DOMAINS.durby, 'owner@durby.local');
    await invite(page, DOMAINS.durby, email, 'Staff');
    const staff = await accept(browser, await invitationLink(request, email));

    const nav = staff.getByRole('navigation', { name: 'Main navigation' });
    await expect(nav.getByTestId('nav-home')).toBeVisible();
    await expect(nav.getByTestId('nav-settings')).toBeVisible();

    const origin = new URL(staff.url()).origin;
    await staff.goto(`${origin}/settings/organization`);
    await expect(staff.getByTestId('settings-tab-general')).toBeVisible();
    await expect(staff.getByTestId('settings-tab-members')).toHaveCount(0);
    await expect(staff.getByTestId('settings-tab-roles')).toHaveCount(0);
    await staff.goto(`${origin}/settings/members`);
    await expect(staff.getByTestId('no-access')).toBeVisible();
    await staff.goto(`${origin}/settings/roles`);
    await expect(staff.getByTestId('no-access')).toBeVisible();
    await staff.context().close();
  });
});
