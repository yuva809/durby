import { AUDIT_ENTITY_TYPES } from '@durby/shared';
import { describe, expect, it } from 'vitest';
import { AUDIT_SNAPSHOT_FIELDS, snapshot } from './audit-snapshots';

// ADR 0008 §5: secrets and emails never reach an audit row.
const FORBIDDEN_FIELD = /hash|token|password|secret|link|email|cookie|apikey/i;

describe('audit snapshot allow-lists', () => {
  it('cover every entity type', () => {
    expect(Object.keys(AUDIT_SNAPSHOT_FIELDS).sort()).toEqual([...AUDIT_ENTITY_TYPES].sort());
  });

  it.each(Object.entries(AUDIT_SNAPSHOT_FIELDS))(
    '%s lists no secret-like field',
    (_type, fields) => {
      expect(fields.filter((field) => FORBIDDEN_FIELD.test(field))).toEqual([]);
    },
  );
});

describe('snapshot()', () => {
  it('keeps only allow-listed fields of a full row', () => {
    const row = {
      id: 'inv-1',
      email: 'someone@example.com',
      roleId: 'role-1',
      allLocations: false,
      locationIds: ['b', 'a'],
      tokenHash: 'deadbeef',
      invitedByUserId: 'user-1',
      expiresAt: new Date('2026-10-30T10:00:00Z'),
      acceptedAt: null,
    };
    expect(snapshot('invitation', row)).toEqual({
      id: 'inv-1',
      roleId: 'role-1',
      allLocations: false,
      locationIds: ['a', 'b'],
      expiresAt: '2026-10-30T10:00:00.000Z',
      acceptedAt: null,
    });
  });

  it('drops undefined fields and keeps null', () => {
    expect(snapshot('role', { id: 'r', name: undefined, systemKey: null })).toEqual({
      id: 'r',
      systemKey: null,
    });
  });

  it('rejects nested objects under an allowed name', () => {
    expect(() =>
      snapshot('membership', {
        id: 'm',
        userId: { id: 'u', passwordHash: 'x' } as unknown as string,
      }),
    ).toThrow(/membership\.userId/);
  });
});
