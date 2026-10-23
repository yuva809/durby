import { describe, expect, it } from 'vitest';
import {
  dictionaries,
  isOrgOverridable,
  type LabelKey,
  NEVER_ORG_OVERRIDABLE,
  validateOverride,
} from './index';

const KEYS = Object.keys(dictionaries.en) as LabelKey[];

describe('isOrgOverridable', () => {
  it('allows terminology keys', () => {
    expect(isOrgOverridable('inventory.nav.title')).toBe(true);
    expect(isOrgOverridable('platform.nav.label')).toBe(true);
    expect(isOrgOverridable('inventory.entities.item')).toBe(true);
    expect(isOrgOverridable('inventory.fields.sku.hint')).toBe(true);
  });

  it.each([
    'platform.email.invite.subject',
    'platform.email.invite.body',
    'auth.email.reset.subject',
    'auth.email.verify.body',
    'platform.errors.permissionDenied',
    'auth.errors.invalidCredentials',
    'platform.invite.errors.emailMismatch',
    'inventory.nav.errors.x',
    'platform.app.name',
  ])('denies %s', (key) => {
    expect(isOrgOverridable(key)).toBe(false);
  });

  it('denies keys outside the allow-list', () => {
    expect(isOrgOverridable('platform.home.title')).toBe(false);
    expect(isOrgOverridable('platform.audit.entities.settingValue')).toBe(false);
    expect(isOrgOverridable('platform.roles.owner')).toBe(false);
    expect(isOrgOverridable('nav.title')).toBe(false);
  });

  it('allows at least one dictionary key and none from the deny-list areas', () => {
    expect(KEYS.filter(isOrgOverridable)).toContain('inventory.nav.title');
    const denied = KEYS.filter(
      (key) =>
        key.startsWith('platform.email.') ||
        key.startsWith('auth.email.') ||
        key.split('.').includes('errors') ||
        key === 'platform.app.name',
    );
    expect(denied.length).toBeGreaterThan(0);
    expect(denied.filter(isOrgOverridable)).toEqual([]);
    expect(NEVER_ORG_OVERRIDABLE).toContain('platform.app.name');
  });
});

describe('validateOverride', () => {
  it('accepts plain text with the same placeholders', () => {
    expect(validateOverride('inventory.nav.title', 'de', 'Produkte', 'organization')).toEqual({
      ok: true,
    });
    expect(
      validateOverride(
        'platform.email.invite.body',
        'en',
        '{link}\n\nJoin {organization} ({organization}).',
        'partner',
      ),
    ).toEqual({ ok: true });
  });

  it.each([
    ['blank', '   '],
    ['blank', ''],
    ['too_long', 'x'.repeat(201)],
    ['line_break', 'Pro\nducts'],
    ['line_break', 'Pro\rducts'],
    ['control_character', 'Pro\u0000ducts'],
    ['control_character', 'Pro\tducts'],
    ['control_character', 'Pro‮ducts'],
    ['braces', 'Products {'],
    ['braces', 'Products {}'],
    ['braces', '{ not a placeholder }'],
  ])('rejects %s at organization level: %j', (reason, value) => {
    expect(validateOverride('inventory.nav.title', 'en', value, 'organization')).toMatchObject({
      ok: false,
      reason,
    });
  });

  it('counts code points, like char_length', () => {
    expect(validateOverride('inventory.nav.title', 'en', '😀'.repeat(200), 'organization')).toEqual(
      {
        ok: true,
      },
    );
  });

  it('allows line breaks and up to 1000 characters for partners', () => {
    const key: LabelKey = 'platform.home.title';
    expect(validateOverride(key, 'en', 'a\nb', 'partner')).toEqual({ ok: true });
    expect(validateOverride(key, 'en', 'x'.repeat(1000), 'partner')).toEqual({ ok: true });
    expect(validateOverride(key, 'en', 'x'.repeat(1001), 'partner')).toMatchObject({
      reason: 'too_long',
    });
    expect(validateOverride(key, 'en', 'a\r\nb', 'partner')).toMatchObject({
      reason: 'control_character',
    });
  });

  it('requires exactly the placeholders of the default text in that locale', () => {
    expect(validateOverride('platform.email.invite.subject', 'de', 'Einladung', 'partner')).toEqual(
      { ok: false, reason: 'placeholders', expected: ['organization'], found: [] },
    );
    expect(
      validateOverride('platform.email.invite.subject', 'en', '{organization} {link}', 'partner'),
    ).toEqual({
      ok: false,
      reason: 'placeholders',
      expected: ['organization'],
      found: ['link', 'organization'],
    });
    expect(validateOverride('inventory.nav.title', 'en', 'Products {org}', 'organization')).toEqual(
      { ok: false, reason: 'placeholders', expected: [], found: ['org'] },
    );
  });
});
