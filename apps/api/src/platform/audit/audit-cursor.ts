import { z } from 'zod';

const uuid = z.uuid();

/**
 * Opaque page cursor: base64url of the last row's uuid v7 id. Clients never build one; only the
 * format is checked here, and a cursor from another tenant just finds no rows (RLS).
 */
export function encodeCursor(id: string): string {
  return Buffer.from(id, 'utf8').toString('base64url');
}

/** The id inside a cursor, or null if it isn't one. */
export function decodeCursor(cursor: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) return null;
  const id = Buffer.from(cursor, 'base64url').toString('utf8');
  return uuid.safeParse(id).success ? id : null;
}
