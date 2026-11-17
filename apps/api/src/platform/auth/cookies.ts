import { MAX_SIGNED_IN_ACCOUNTS } from '@durby/shared';
import type { CookieOptions } from 'express';
import type { AppConfig } from '../config';
import { API_PREFIX } from '../http';

/** Sent only to the auth endpoints, never to the rest of the api. */
export const REFRESH_COOKIE_PATH = `/${API_PREFIX}/auth`;

type CookieConfig = Pick<AppConfig, 'COOKIE_SECURE'>;

/**
 * `__Secure-` requires the Secure attribute, so the prefix is used only when the cookie is Secure. Slot 0 is the cookie
 * as before; slots 1 … 4 are the other signed-in accounts of the browser (ADR 0047).
 */
export function refreshCookieName(config: CookieConfig, slot = 0): string {
  const base = config.COOKIE_SECURE ? '__Secure-durby_rt' : 'durby_rt';
  return slot === 0 ? base : `${base}_${slot}`;
}

/** The account slot of a request (ACCOUNT_SLOT_HEADER); none is 0, anything but 0 … 4 is null (refused). */
export function accountSlot(header: string | string[] | undefined): number | null {
  if (header === undefined) return 0;
  if (typeof header !== 'string' || !/^[0-9]$/.test(header)) return null;
  const slot = Number(header);
  return slot < MAX_SIGNED_IN_ACCOUNTS ? slot : null;
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
