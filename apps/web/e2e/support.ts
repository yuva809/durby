import { type APIRequestContext, expect, type Page } from '@playwright/test';

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
