import type { CookieOptions, Request } from 'express';
import type { AppConfig } from '../config';
import { API_PREFIX } from '../http';

/** Sent only to the staff api, never to customer routes (ADR 0017 §4). */
export const STAFF_COOKIE_PATH = `/${API_PREFIX}/platform`;

type CookieConfig = Pick<AppConfig, 'COOKIE_SECURE'>;

/** `__Secure-` requires the Secure attribute, so the prefix is used only when the cookie is Secure. */
export function staffCookieName(config: CookieConfig): string {
  return config.COOKIE_SECURE ? '__Secure-durby_staff' : 'durby_staff';
}

export function staffCookieOptions(config: CookieConfig, expiresAt?: Date): CookieOptions {
  return {
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: 'strict',
    path: STAFF_COOKIE_PATH,
    ...(expiresAt && { expires: expiresAt }),
  };
}

export function staffCookie(req: Request, config: CookieConfig): string | undefined {
  const value: unknown = (req.cookies as Record<string, unknown> | undefined)?.[
    staffCookieName(config)
  ];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
