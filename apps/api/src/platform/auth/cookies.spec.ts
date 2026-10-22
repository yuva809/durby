import { describe, expect, it } from 'vitest';
import { clearRefreshCookieOptions, refreshCookieName, refreshCookieOptions } from './cookies';

describe('refresh cookie', () => {
  const expires = new Date('2026-11-05T12:00:00Z');

  it('is __Secure-durby_rt, Secure, HttpOnly, SameSite=Strict, auth path only (default)', () => {
    const config = { COOKIE_SECURE: true };
    expect(refreshCookieName(config)).toBe('__Secure-durby_rt');
    expect(refreshCookieOptions(config, expires)).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/api/v1/auth',
      expires,
    });
  });

  it('drops the __Secure- prefix together with Secure (COOKIE_SECURE=false, dev only)', () => {
    const config = { COOKIE_SECURE: false };
    expect(refreshCookieName(config)).toBe('durby_rt');
    expect(refreshCookieOptions(config, expires)).toMatchObject({ secure: false, httpOnly: true });
  });

  it('clears with the same path and flags', () => {
    expect(clearRefreshCookieOptions({ COOKIE_SECURE: true })).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/api/v1/auth',
    });
  });
});
