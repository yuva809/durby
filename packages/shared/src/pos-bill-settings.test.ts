import { describe, expect, it } from 'vitest';
import {
  BILL_LOGO_MAX_LENGTH,
  billFooterSchema,
  billHeaderSchema,
  DEFAULT_BILL_FOOTER,
  DEFAULT_BILL_HEADER,
} from './pos-bill-settings';
import { SETTINGS } from './settings';

const header = (patch: object) => billHeaderSchema.safeParse({ ...DEFAULT_BILL_HEADER, ...patch });

describe('bill header', () => {
  it('is registered with empty defaults at every scope', () => {
    expect(SETTINGS['pos.billHeader'].default).toEqual(DEFAULT_BILL_HEADER);
    expect(SETTINGS['pos.billFooter'].default).toEqual(DEFAULT_BILL_FOOTER);
    expect(SETTINGS['pos.billHeader'].scopes).toContain('location');
  });

  it('takes the contact fields', () => {
    const parsed = header({
      name: ' Bay Leaf ',
      phone: '+49 30 1234567',
      email: 'hello@bayleaf.example',
      website: 'www.bayleaf.example',
    });
    expect(parsed.success && parsed.data.name).toBe('Bay Leaf');
  });

  it('rejects empty text instead of storing it (null means none)', () => {
    expect(header({ phone: '  ' }).success).toBe(false);
    expect(header({ email: 'not an email' }).success).toBe(false);
  });

  it('takes a png, jpeg or webp data URL as logo', () => {
    for (const type of ['png', 'jpeg', 'webp']) {
      expect(header({ logo: `data:image/${type};base64,iVBORw0KGgo=` }).success).toBe(true);
    }
  });

  it('rejects other logos: links, svg, oversize', () => {
    expect(header({ logo: 'https://example.com/logo.png' }).success).toBe(false);
    expect(header({ logo: 'data:image/svg+xml;base64,PHN2Zz4=' }).success).toBe(false);
    const big = `data:image/png;base64,${'A'.repeat(BILL_LOGO_MAX_LENGTH)}`;
    expect(header({ logo: big }).success).toBe(false);
  });

  it('is strict', () => {
    expect(header({ address: 'Main St 1' }).success).toBe(false);
  });
});

describe('bill footer', () => {
  it('takes up to 4 lines of up to 64 characters', () => {
    const lines = ['Thank you for visiting!', 'Vielen Dank für Ihren Besuch!'];
    expect(billFooterSchema.safeParse({ lines }).success).toBe(true);
    expect(billFooterSchema.safeParse({ lines: ['a', 'b', 'c', 'd', 'e'] }).success).toBe(false);
    expect(billFooterSchema.safeParse({ lines: ['x'.repeat(65)] }).success).toBe(false);
    expect(billFooterSchema.safeParse({ lines: [' '] }).success).toBe(false);
  });
});
