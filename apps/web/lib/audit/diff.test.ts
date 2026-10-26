import { createTranslator, dictionaries, LOCALES } from '@durby/i18n';
import {
  AUDIT_ACTION_KEYS,
  AUDIT_ACTIONS,
  AUDIT_ENTITY_TYPES,
  AUDIT_SNAPSHOT_FIELDS,
  AUDIT_SYSTEM_ACTORS,
  auditEntityLabel,
} from '@durby/shared';
import { describe, expect, it } from 'vitest';
import { diffRows, fieldLabel, type FormatContext, formatValue } from './diff';

const ROLE = '0190a000-0000-7000-8000-000000000101';
const LOC = '0190a000-0000-7000-8000-000000000201';
const ctx: FormatContext = {
  t: createTranslator('en'),
  locale: 'en',
  timeZone: 'Europe/Berlin',
  roles: [{ id: ROLE, systemKey: 'manager', name: null, permissions: [] }],
  locations: [{ id: LOC, name: 'Main street', brandId: ROLE }],
};

describe('audit diff', () => {
  it('lists changed and unchanged fields of an update, without the id', () => {
    const rows = diffRows({
      entityType: 'setting_value',
      before: { id: 'x', key: 'timezone', value: '"Europe/Berlin"' },
      after: { id: 'x', key: 'timezone', value: '"Europe/Vienna"' },
    });
    expect(rows.map((r) => [r.field, r.changed])).toEqual([
      ['key', false],
      ['value', true],
    ]);
    // Empty on both sides: left out.
    expect(
      diffRows({
        entityType: 'setting_value',
        before: { key: 'timezone', brandId: null },
        after: { key: 'timezone', brandId: null },
      }).map((r) => r.field),
    ).toEqual(['key']);
  });

  it('shows only after for a create and only before for a delete', () => {
    const created = diffRows({
      entityType: 'role',
      before: null,
      after: { id: 'x', name: 'Lead' },
    });
    expect(created).toEqual([
      {
        field: 'name',
        before: undefined,
        after: 'Lead',
        changed: true,
        hasBefore: false,
        hasAfter: true,
      },
    ]);
    const deleted = diffRows({ entityType: 'role', before: { name: 'Lead' }, after: null });
    expect(deleted[0]).toMatchObject({ hasBefore: true, hasAfter: false, changed: true });
  });

  it('keeps fields outside the allow-list visible at the end (older rows)', () => {
    const rows = diffRows({
      entityType: 'role',
      before: { legacy: 1 },
      after: { legacy: 2, name: 'A' },
    });
    expect(rows.map((r) => r.field)).toEqual(['name', 'legacy']);
  });

  it('makes values readable', () => {
    expect(formatValue('allLocations', true, ctx)).toBe('Yes');
    expect(formatValue('roleId', ROLE, ctx)).toBe('Manager');
    expect(formatValue('locationIds', [LOC], ctx)).toBe('Main street');
    expect(formatValue('locationIds', [], ctx)).toBe('None');
    expect(formatValue('systemKey', 'owner', ctx)).toBe('Owner');
    expect(formatValue('permissions', ['platform.users.read', 'platform.audit.read'], ctx)).toBe(
      'View members and invitations, View the audit log',
    );
    expect(formatValue('expiresAt', '2026-10-25T23:30:00.000Z', ctx)).toBe(
      'Oct 26, 2026, 12:30 AM',
    );
    expect(formatValue('acceptedAt', null, ctx)).toBe('—');
    // Canonical JSON text of setting values: scalars shown as themselves, objects as JSON.
    expect(formatValue('value', '"Europe/Vienna"', ctx)).toBe('Europe/Vienna');
    expect(formatValue('value', 'true', ctx)).toBe('Yes');
    expect(formatValue('limits', '{"maxLocations":3}', ctx)).toBe('{"maxLocations":3}');
    // Registry keys and enum values by their names.
    const setting = { ...ctx, entityType: 'setting_value' as const };
    expect(formatValue('key', 'inventory.allowNegativeStock', setting)).toBe(
      'Allow negative stock',
    );
    expect(formatValue('scopeType', 'organization', setting)).toBe('Organization');
    expect(formatValue('seriesKey', 'billing.invoice', ctx)).toBe('Invoices');
    expect(formatValue('featureKey', 'inventory.counts', ctx)).toBe('Stock counts');
    expect(formatValue('resetPolicy', 'yearly', ctx)).toBe('Every year');
    // A label override's key stays a key.
    expect(
      formatValue('key', 'inventory.nav.title', { ...ctx, entityType: 'label_override' }),
    ).toBe('inventory.nav.title');
    // Unknown ids stay as they are.
    expect(formatValue('roleId', LOC, ctx)).toBe(LOC);
  });

  it('labels every snapshot field, action, entity type and system actor in en and de', () => {
    const fields = new Set(Object.values(AUDIT_SNAPSHOT_FIELDS).flat());
    for (const locale of LOCALES) {
      for (const field of fields) {
        if (field === 'id') continue;
        const label = fieldLabel(field);
        expect(label, field).not.toBeNull();
        expect(dictionaries[locale][label!], field).toBeTruthy();
      }
      for (const action of AUDIT_ACTION_KEYS) {
        expect(
          dictionaries[locale][AUDIT_ACTIONS[action].label as keyof typeof dictionaries.en],
        ).toBeTruthy();
      }
      for (const type of AUDIT_ENTITY_TYPES) {
        expect(
          dictionaries[locale][auditEntityLabel(type) as keyof typeof dictionaries.en],
        ).toBeTruthy();
      }
      for (const actor of Object.values(AUDIT_SYSTEM_ACTORS)) {
        expect(dictionaries[locale][actor.label as keyof typeof dictionaries.en]).toBeTruthy();
      }
    }
  });
});
