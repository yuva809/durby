import { dictionaries, type LabelKey } from '@durby/i18n';
import { describe, expect, it } from 'vitest';
import {
  LABEL_ERROR_CODES,
  labelErrorLabel,
  labelOverridesResponseSchema,
  labelsQuerySchema,
  putLabelOverrideRequestSchema,
} from './labels';

describe('labels API schemas', () => {
  it('takes a supported locale or none, and nothing else', () => {
    expect(labelsQuerySchema.safeParse({}).success).toBe(true);
    expect(labelsQuerySchema.safeParse({ locale: 'de' }).success).toBe(true);
    expect(labelsQuerySchema.safeParse({ locale: 'fr' }).success).toBe(false);
    expect(labelsQuerySchema.safeParse({ locale: 'de', tenantId: 'x' }).success).toBe(false);
  });

  it('needs a string value in the body', () => {
    expect(putLabelOverrideRequestSchema.safeParse({ value: 'Products' }).success).toBe(true);
    expect(putLabelOverrideRequestSchema.safeParse({ value: 1 }).success).toBe(false);
    expect(putLabelOverrideRequestSchema.safeParse({}).success).toBe(false);
    expect(putLabelOverrideRequestSchema.safeParse({ value: 'x', locale: 'en' }).success).toBe(
      false,
    );
  });

  it('describes stored overrides', () => {
    const body = {
      data: [
        {
          locale: 'en',
          key: 'inventory.nav.title',
          value: 'Products',
          defaultValue: 'Inventory',
          active: true,
        },
      ],
    };
    expect(labelOverridesResponseSchema.parse(body)).toEqual(body);
  });

  it('maps every error code to a label in en and de', () => {
    expect(labelErrorLabel('labels.not_overridable')).toBe('platform.errors.labelsNotOverridable');
    for (const code of LABEL_ERROR_CODES) {
      const key = labelErrorLabel(code) as LabelKey;
      expect(dictionaries.en[key], code).toBeTypeOf('string');
      expect(dictionaries.de[key], code).toBeTypeOf('string');
    }
  });
});
