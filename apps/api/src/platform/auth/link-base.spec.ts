import { describe, expect, it } from 'vitest';
import { mailLinkBase } from './link-base';

const ORIGINS = [
  'https://app.durby.tech',
  'https://partner-demo.durby.tech',
  'https://app.asiamight.site',
];
const FALLBACK = 'https://app.durby.tech';

/** ADR 0041: password and onboarding links open on the user's own site, never on one a client names. */
describe('mailLinkBase', () => {
  it("uses the partner's domain when it is an allowed origin", () => {
    expect(
      mailLinkBase(ORIGINS, FALLBACK, {
        partnerHostnames: ['asiamight.localhost', 'app.asiamight.site'],
      }),
    ).toBe('https://app.asiamight.site');
  });

  it('falls back to WEB_BASE_URL for a partner without a served domain (Durby itself)', () => {
    expect(mailLinkBase(ORIGINS, FALLBACK, { partnerHostnames: [] })).toBe(FALLBACK);
    expect(mailLinkBase(ORIGINS, FALLBACK, { partnerHostnames: ['asiamight.localhost'] })).toBe(
      FALLBACK,
    );
  });

  it("uses the asking browser's origin only when it is exactly an allowed origin", () => {
    expect(mailLinkBase(ORIGINS, FALLBACK, { requestOrigin: 'https://app.asiamight.site' })).toBe(
      'https://app.asiamight.site',
    );
    for (const origin of [
      'https://evil.example.com',
      'https://app.asiamight.site.evil.example.com',
      'http://app.asiamight.site',
      'https://APP.asiamight.site',
      'https://app.asiamight.site/reset',
      '',
    ]) {
      expect(mailLinkBase(ORIGINS, FALLBACK, { requestOrigin: origin }), origin).toBe(FALLBACK);
    }
  });

  it('prefers the partner domain over the request origin, and defaults to WEB_BASE_URL', () => {
    expect(
      mailLinkBase(ORIGINS, FALLBACK, {
        partnerHostnames: ['app.asiamight.site'],
        requestOrigin: 'https://partner-demo.durby.tech',
      }),
    ).toBe('https://app.asiamight.site');
    expect(mailLinkBase(ORIGINS, FALLBACK)).toBe(FALLBACK);
  });
});
