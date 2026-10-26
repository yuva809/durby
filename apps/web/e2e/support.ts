import { type APIRequestContext, type Browser, expect, type Page } from '@playwright/test';

/** Seeded by `seed-dev` (apps/api/src/cli/seed-dev.ts); local and CI only. */
export const DEV_PASSWORD = 'durby-dev-password';

export const DOMAINS = {
  durby: 'http://durby.localhost:3000',
  demo: 'http://partner-demo.localhost:3000',
} as const;

export async function signIn(page: Page, origin: string, email: string): Promise<void> {
  await page.goto(`${origin}/login`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(DEV_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('main')).toContainText('Back office');
}

/** A theme token as the page computes it (the root layout's <style> on :root). */
export function token(page: Page, name: string): Promise<string> {
  return page.evaluate(
    (variable) => getComputedStyle(document.documentElement).getPropertyValue(variable).trim(),
    `--${name}`,
  );
}

/** Mailpit's API (docker-compose.yml): every mail the local stack sends lands there. */
export const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';

/** The invitation link of the newest mail to `email`, waiting for it to arrive. */
export async function invitationLink(request: APIRequestContext, email: string): Promise<URL> {
  let text = '';
  await expect
    .poll(
      async () => {
        const search = await request.get(`${MAILPIT}/api/v1/search`, {
          params: { query: `to:"${email}"` },
        });
        const found = (await search.json()) as { messages: { ID: string }[] };
        const first = found.messages[0];
        if (!first) return '';
        const message = await request.get(`${MAILPIT}/api/v1/message/${first.ID}`);
        text = ((await message.json()) as { Text: string }).Text;
        return text;
      },
      { timeout: 15_000 },
    )
    .toContain('/accept-invite#token=');
  const link = /(https?:\/\/\S+\/accept-invite#token=\S+)/.exec(text)?.[1];
  if (!link) throw new Error(`no invitation link in the mail to ${email}`);
  return new URL(link);
}

const NEW_PASSWORD = 'e2e-invitee-password';

/** As the signed-in Owner: invites `email` as `role` from the Invitations tab. */
export async function invite(
  page: Page,
  origin: string,
  email: string,
  role: string,
): Promise<void> {
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
export async function accept(browser: Browser, link: URL): Promise<Page> {
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

export const uniqueEmail = (tag: string) =>
  `e2e-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
