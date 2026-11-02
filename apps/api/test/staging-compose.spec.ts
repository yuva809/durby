import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const composeFile = path.join(__dirname, '../../../infra/staging/docker-compose.staging.yml');
const text = readFileSync(composeFile, 'utf8');

/** The `x-api-env` anchor block: shared by the api and the worker. */
const apiEnv = /^x-api-env: &api-env\n((?: {2}.*\n|\n)+)/m.exec(text)?.[1] ?? '';

describe('staging compose mail settings (docs/ops/deploy.md → Staging mail)', () => {
  it('defaults to Mailpit and lets /opt/durby/.env override SMTP_URL', () => {
    expect(apiEnv).toMatch(/^ {2}SMTP_URL: \$\{SMTP_URL:-smtp:\/\/mailpit:1025\}$/m);
  });

  it('lets /opt/durby/.env override MAIL_FROM', () => {
    expect(apiEnv).toMatch(/^ {2}MAIL_FROM: \$\{MAIL_FROM:-.+\}$/m);
  });

  it('gives the api and the worker the same environment', () => {
    const users = text.match(/^ {4}environment: \*api-env$/gm) ?? [];
    expect(users).toHaveLength(2);
  });
});
