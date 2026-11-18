import { describe, expect, it } from 'vitest';
import {
  accountSlot,
  clearRefreshCookieOptions,
  refreshCookieName,
  refreshCookieOptions,
} from './cookies';

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

  it('has one cookie per signed-in account; slot 0 keeps the old name (ADR 0047)', () => {
    expect(refreshCookieName({ COOKIE_SECURE: true }, 0)).toBe('__Secure-durby_rt');
    expect(refreshCookieName({ COOKIE_SECURE: true }, 3)).toBe('__Secure-durby_rt_3');
    expect(refreshCookieName({ COOKIE_SECURE: false }, 1)).toBe('durby_rt_1');
  });

  it('reads the slot header: none is 0, only 0 to 4', () => {
    expect(accountSlot(undefined)).toBe(0);
    expect(accountSlot('4')).toBe(4);
    for (const bad of ['5', '-1', '01', 'x', '', ['1']]) expect(accountSlot(bad)).toBeNull();
  });
});
