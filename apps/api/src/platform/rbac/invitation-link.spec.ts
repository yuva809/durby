import { describe, expect, it } from 'vitest';
import { inviteLinkBase } from './invitation-link';

const FALLBACK = 'https://staging.durby.tech';

describe('inviteLinkBase', () => {
  it("uses the allowed origin on one of the partner's domains", () => {
    expect(
      inviteLinkBase(
        ['http://durby.localhost:3000', 'http://partner-demo.localhost:3000'],
        FALLBACK,
        ['partner-demo.localhost', 'partner-demo.durby.tech'],
      ),
    ).toBe('http://partner-demo.localhost:3000');
  });

  it('takes the first matching origin when the partner has several', () => {
    expect(
      inviteLinkBase(['https://b.example.test', 'https://a.example.test'], FALLBACK, [
        'a.example.test',
        'b.example.test',
      ]),
    ).toBe('https://b.example.test');
  });

  it('falls back when the partner has no domain or none of them is an allowed origin', () => {
    expect(inviteLinkBase(['https://staging.durby.tech'], FALLBACK, [])).toBe(FALLBACK);
    expect(
      inviteLinkBase(['https://staging.durby.tech'], FALLBACK, ['partner-demo.localhost']),
    ).toBe(FALLBACK);
  });

  it('compares hostnames only, case-insensitively, and skips malformed origins', () => {
    expect(
      inviteLinkBase(['not a url', 'https://Partner-Demo.Durby.Tech'], FALLBACK, [
        'partner-demo.durby.tech',
      ]),
    ).toBe('https://partner-demo.durby.tech');
    // A hostname that only shares a suffix is not a match.
    expect(inviteLinkBase(['https://evil-demo.durby.tech'], FALLBACK, ['demo.durby.tech'])).toBe(
      FALLBACK,
    );
  });
});
