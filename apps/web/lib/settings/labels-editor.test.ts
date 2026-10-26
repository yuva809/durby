import { createTranslator, isOrgOverridable } from '@durby/i18n';
import { describe, expect, it } from 'vitest';
import {
  inactiveReason,
  moduleLabel,
  overridableKeys,
  overrideProblem,
  previewText,
} from './labels-editor';

const t = createTranslator('en');

describe('labels editor', () => {
  it('offers only org-overridable keys, grouped by module', () => {
    const groups = overridableKeys();
    const keys = groups.flatMap((g) => g.keys);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every(isOrgOverridable)).toBe(true);
    expect(keys).toContain('inventory.nav.title');
    expect(keys).not.toContain('platform.app.name');
    expect(keys.some((k) => k.includes('.errors.'))).toBe(false);
    for (const group of groups)
      expect(group.keys.every((k) => k.startsWith(`${group.module}.`))).toBe(true);
  });

  it('accepts plain terminology and explains each problem inline', () => {
    expect(overrideProblem(t, 'inventory.nav.title', 'en', 'Stock')).toBeNull();
    expect(overrideProblem(t, 'inventory.nav.title', 'en', '   ')).toBe('Enter a text.');
    expect(overrideProblem(t, 'inventory.nav.title', 'en', 'a\nb')).toBe('Use a single line.');
    expect(overrideProblem(t, 'inventory.nav.title', 'en', 'x'.repeat(201))).toBe(
      'Use at most 200 characters.',
    );
    expect(overrideProblem(t, 'inventory.nav.title', 'en', 'Stock {count}')).toBe(
      'Keep exactly the placeholders of the default text: none. Found: {count}.',
    );
    expect(overrideProblem(t, 'inventory.nav.title', 'en', 'Stock }')).toBe(
      'Curly braces are only allowed around placeholders.',
    );
  });

  it('heads module groups with the module title, never a raw id', () => {
    expect(moduleLabel('inventory')).toBe('inventory.nav.title');
    expect(moduleLabel('platform')).toBe('platform.labelsEditor.general');
    expect(moduleLabel('unknown')).toBe('platform.labelsEditor.general');
    for (const { module } of overridableKeys()) expect(t(moduleLabel(module))).not.toBe(module);
  });

  it('previews placeholders as markers', () => {
    expect(previewText('{count} items')).toBe('‹count› items');
    expect(previewText('Stock')).toBe('Stock');
  });

  it('explains inactive rows', () => {
    const row = { locale: 'en', key: 'inventory.nav.title', value: 'x', active: false };
    expect(inactiveReason({ ...row, defaultValue: null })).toBe('removed');
    expect(inactiveReason({ ...row, key: 'gone.nav.key', defaultValue: 'x' })).toBe('removed');
    expect(
      inactiveReason({ ...row, key: 'platform.home.title', defaultValue: 'Back office' }),
    ).toBe('notOverridable');
    expect(inactiveReason({ ...row, defaultValue: 'Inventory' })).toBe('invalid');
  });
});
