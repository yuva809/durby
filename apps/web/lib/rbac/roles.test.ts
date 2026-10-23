import { createTranslator } from '@durby/i18n';
import { describe, expect, it } from 'vitest';
import { roleName } from './roles';

describe('roleName', () => {
  it('uses the label of a system role and the stored name of a custom role', () => {
    expect(roleName({ systemKey: 'owner', name: null })).toBe('Owner');
    expect(roleName({ systemKey: null, name: 'Shift lead' })).toBe('Shift lead');
  });

  it('uses the translator it is given', () => {
    expect(roleName({ systemKey: 'owner', name: null }, createTranslator('de'))).toBe('Inhaber');
  });
});
