import { expect, type Page } from '@playwright/test';

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
