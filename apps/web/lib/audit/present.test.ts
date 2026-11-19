import type { AuditLogEntry, TeamMember } from '@durby/shared';
import { describe, expect, it } from 'vitest';
import { csvCell, detailOf, matchesSearch, recordOf, toCsv, whereOf, whoOf } from './present';

const t = (key: string, params?: Record<string, string>) =>
  params ? `${key}(${Object.values(params).join('|')})` : key;
const LOC = '0190a000-0000-7000-8000-000000000001';
const USER = '0190a000-0000-7000-8000-000000000002';

const entry = (before: Record<string, unknown> | null, after: Record<string, unknown> | null) =>
  ({
    entityType: 'dining_table',
    before,
    after,
    actor: { type: 'user', userId: USER, email: 'ravi@example.test' },
  }) as unknown as AuditLogEntry;

describe('audit presentation', () => {
  it('names the record by name, number or email, else nothing', () => {
    expect(recordOf(entry(null, { id: 'x', name: 'T1' }))).toBe('T1');
    expect(recordOf(entry({ number: 'BILL-1' }, null))).toBe('BILL-1');
    expect(recordOf(entry(null, { id: 'x', sortOrder: 2 }))).toBeNull();
  });

  it('places it at its location, or nowhere for organization-wide records', () => {
    const locations = [
      {
        id: LOC,
        name: 'Main street',
        brandId: LOC,
        address: null,
        archivedAt: null,
        isWarehouseSite: false,
      },
    ];
    expect(whereOf(entry(null, { locationId: LOC }), locations)).toBe('Main street');
    expect(whereOf(entry(null, { name: 'Soup' }), locations)).toBeNull();
  });

  it('says what was set, changed or deleted', () => {
    expect(detailOf(entry(null, { id: 'x', name: 'T1', seats: 4 }), t)).toBe(
      'platform.auditPage.detailSet(platform.audit.fields.name, platform.audit.fields.seats)',
    );
    expect(
      detailOf(entry({ id: 'x', name: 'T1', seats: 4 }, { id: 'x', name: 'T1', seats: 6 }), t),
    ).toBe('platform.auditPage.detailChanged(platform.audit.fields.seats)');
    expect(detailOf(entry({ id: 'x', name: 'T1' }, null), t)).toBe(
      'platform.auditPage.detailDeleted',
    );
  });

  it('shows who by name, email and role when the team is readable, else by email', () => {
    const team = [
      {
        userId: USER,
        name: 'Ravi',
        email: 'ravi@example.test',
        role: { id: LOC, systemKey: 'owner', name: null },
      },
    ] as unknown as TeamMember[];
    const system = (key: string) => key;
    expect(whoOf(entry(null, {}), team, t, system)).toEqual({
      name: 'Ravi',
      email: 'ravi@example.test',
      role: 'platform.roles.owner',
      userId: USER,
    });
    expect(whoOf(entry(null, {}), null, t, system)).toMatchObject({
      name: 'ravi@example.test',
      email: null,
      role: null,
    });
  });

  it('searches the visible texts, ignoring case', () => {
    expect(matchesSearch(['T1', 'Ravi'], 'rav')).toBe(true);
    expect(matchesSearch(['T1', null], 'x')).toBe(false);
    expect(matchesSearch(['T1'], undefined)).toBe(true);
  });

  it('writes CSV that spreadsheets read safely', () => {
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell(null)).toBe('""');
    expect(
      toCsv([
        ['a', 'b'],
        ['c', null],
      ]),
    ).toBe('"a","b"\r\n"c",""');
  });
});
