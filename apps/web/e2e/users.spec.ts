import { type Browser, expect, type Page, test } from '@playwright/test';
import { DOMAINS, invitationLink, signIn } from './support';

// docs/platform/web-shell.md → Users, roles, invitations (PR b).

const NEW_PASSWORD = 'e2e-invitee-password';

/** As the signed-in Owner: invites `email` as `role` from the Invitations tab. */
async function invite(page: Page, origin: string, email: string, role: string): Promise<void> {
  await page.goto(`${origin}/settings/members`);
  await page.getByTestId('tab-invitations').click();
  await page.getByTestId('invite-open').click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Email').fill(email);
  await dialog.getByTestId('role-select').selectOption({ label: role });
  await dialog.getByTestId('invite-send').click();
  await expect(page.getByRole('status')).toHaveText(`Invitation sent to ${email}.`);
  await expect(page.getByTestId('invitation-row').filter({ hasText: email })).toContainText(role);
}

/**
 * Accepts the link in a fresh browser (no session) by choosing a password; returns that page,
 * signed in as the new member. The caller closes its context.
 */
async function accept(browser: Browser, link: URL): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(link.toString());
  // Its name includes the hint ("Password At least 12 characters.").
  await page.getByLabel(/^Password/).fill(NEW_PASSWORD);
  await page.getByLabel('Repeat password').fill(NEW_PASSWORD);
  await page.getByRole('button', { name: 'Create account and join' }).click();
  await expect(page.getByRole('main')).toContainText('Back office');
  return page;
}

const uniqueEmail = (tag: string) =>
  `e2e-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;

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
    await expect(nav.getByTestId('nav-members')).toHaveCount(0);
    await expect(nav.getByTestId('nav-roles')).toHaveCount(0);

    const origin = new URL(staff.url()).origin;
    await staff.goto(`${origin}/settings/members`);
    await expect(staff.getByTestId('no-access')).toBeVisible();
    await staff.goto(`${origin}/settings/roles`);
    await expect(staff.getByTestId('no-access')).toBeVisible();
    await staff.context().close();
  });
});
