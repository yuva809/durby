import { v7 as uuidv7 } from 'uuid';
import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor } from './audit-cursor';

describe('audit cursor', () => {
  it('round-trips an id', () => {
    const id = uuidv7();
    expect(decodeCursor(encodeCursor(id))).toBe(id);
  });

  it.each([
    ['not base64url', 'a+b/c='],
    ['not a uuid', Buffer.from('hello').toString('base64url')],
    ['SQL', Buffer.from("' OR 1=1 --").toString('base64url')],
  ])('rejects %s', (_name, cursor) => {
    expect(decodeCursor(cursor)).toBeNull();
  });
});
