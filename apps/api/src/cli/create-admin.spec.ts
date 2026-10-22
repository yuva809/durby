import { describe, expect, it } from 'vitest';
import { parseCreateAdminArgs } from './create-admin';

describe('parseCreateAdminArgs', () => {
  it('reads email, organization and locale', () => {
    expect(
      parseCreateAdminArgs([
        '--email',
        ' Admin@Example.TEST',
        '--org',
        ' Bistro Nord ',
        '--locale',
        'de',
      ]),
    ).toEqual({ email: 'admin@example.test', org: 'Bistro Nord', locale: 'de' });
  });

  it('defaults the locale to en', () => {
    expect(parseCreateAdminArgs(['--email', 'a@b.test', '--org', 'X']).locale).toBe('en');
  });

  it.each([
    [['--org', 'X']],
    [['--email', 'a@b.test']],
    [['--email', 'not-an-email', '--org', 'X']],
    [['--email', 'a@b.test', '--org', '   ']],
    [['--email', 'a@b.test', '--org', 'X', '--locale', 'fr']],
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
