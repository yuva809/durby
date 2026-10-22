import type { CookieOptions } from 'express';
import type { AppConfig } from '../config';
import { API_PREFIX } from '../http';

/** Sent only to the auth endpoints, never to the rest of the api. */
export const REFRESH_COOKIE_PATH = `/${API_PREFIX}/auth`;

type CookieConfig = Pick<AppConfig, 'COOKIE_SECURE'>;

/** `__Secure-` requires the Secure attribute, so the prefix is used only when the cookie is Secure. */
export function refreshCookieName(config: CookieConfig): string {
  return config.COOKIE_SECURE ? '__Secure-durby_rt' : 'durby_rt';
}

export function refreshCookieOptions(config: CookieConfig, expiresAt: Date): CookieOptions {
  return { ...baseOptions(config), expires: expiresAt };
}

/** Options for res.clearCookie: must match name, path and flags of the set cookie. */
export function clearRefreshCookieOptions(config: CookieConfig): CookieOptions {
  return baseOptions(config);
}

function baseOptions(config: CookieConfig): CookieOptions {
  return {
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: 'strict',
    path: REFRESH_COOKIE_PATH,
  };
}
