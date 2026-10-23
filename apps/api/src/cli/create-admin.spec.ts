import { describe, expect, it } from 'vitest';
import { parseCreateAdminArgs } from './create-admin';

describe('parseCreateAdminArgs', () => {
  it('reads email, organization, locale and plan', () => {
    expect(
      parseCreateAdminArgs([
        '--email',
        ' Admin@Example.TEST',
        '--org',
        ' Bistro Nord ',
        '--locale',
        'de',
        '--plan',
        'inventory',
      ]),
    ).toEqual({ email: 'admin@example.test', org: 'Bistro Nord', locale: 'de', plan: 'inventory' });
  });

  it('defaults the locale to en and the plan to full', () => {
    const input = parseCreateAdminArgs(['--email', 'a@b.test', '--org', 'X']);
    expect(input.locale).toBe('en');
    expect(input.plan).toBe('full');
  });

  it.each([
    [['--org', 'X']],
    [['--email', 'a@b.test']],
    [['--email', 'not-an-email', '--org', 'X']],
    [['--email', 'a@b.test', '--org', '   ']],
    [['--email', 'a@b.test', '--org', 'X', '--locale', 'fr']],
    [['--email', 'a@b.test', '--org', 'X', '--plan', 'gold']],
    [['--help']],
  ])('rejects %j with the usage text', (argv) => {
    expect(() => parseCreateAdminArgs(argv)).toThrow(/Usage: create-admin/);
  });

  it('does not accept a password on the command line', () => {
    expect(() =>
      parseCreateAdminArgs(['--email', 'a@b.test', '--org', 'X', '--password', 'secret']),
    ).toThrow(/password/);
  });
});
