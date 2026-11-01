import { describe, expect, it } from 'vitest';
import { countryCodeSchema, normalisePhone } from './phone';

describe('normalisePhone', () => {
  it('reads local German numbers with the location country', () => {
    expect(normalisePhone('030 12345678', 'DE')).toEqual({ ok: true, e164: '+493012345678' });
    expect(normalisePhone('(030) 123 456 78', 'DE')).toEqual({ ok: true, e164: '+493012345678' });
    expect(normalisePhone('0176 12345678', 'DE')).toEqual({ ok: true, e164: '+4917612345678' });
    expect(normalisePhone(' 0176-1234 5678 ', 'DE')).toEqual({ ok: true, e164: '+4917612345678' });
  });

  it('keeps international numbers as they are, with + or 00', () => {
    expect(normalisePhone('+44 20 7946 0958', 'DE')).toEqual({ ok: true, e164: '+442079460958' });
    expect(normalisePhone('0044 20 7946 0958', 'DE')).toEqual({ ok: true, e164: '+442079460958' });
    expect(normalisePhone('+49 176 12345678', 'FR')).toEqual({ ok: true, e164: '+4917612345678' });
  });

  it("reads local numbers with another location's country", () => {
    expect(normalisePhone('06 12 34 56 78', 'FR')).toEqual({ ok: true, e164: '+33612345678' });
    expect(normalisePhone('0664 1234567', 'AT')).toEqual({ ok: true, e164: '+436641234567' });
  });

  it('refuses what it cannot make a valid number of', () => {
    for (const input of [
      '',
      '   ',
      '12',
      '030',
      'abc',
      '0176 ABC 1234',
      '+49 30',
      '+999 1234567',
    ]) {
      expect(normalisePhone(input, 'DE'), input).toEqual({ ok: false });
    }
  });
});

describe('countryCodeSchema', () => {
  it('accepts supported ISO 3166-1 alpha-2 codes only', () => {
    for (const code of ['DE', 'AT', 'CH', 'FR', 'GB', 'US']) {
      expect(countryCodeSchema.safeParse(code).success, code).toBe(true);
    }
    for (const code of ['de', 'DEU', 'XX', '', 'D']) {
      expect(countryCodeSchema.safeParse(code).success, code).toBe(false);
    }
  });
});
