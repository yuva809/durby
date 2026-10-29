import { describe, expect, it } from 'vitest';
import { SecretBox } from './secret-box';

const KEY = 'ab'.repeat(32);

describe('SecretBox', () => {
  it('round-trips, with a fresh IV each time', () => {
    const box = new SecretBox(KEY);
    const a = box.seal('JBSWY3DPEHPK3PXP');
    const b = box.seal('JBSWY3DPEHPK3PXP');
    expect(a).not.toBe(b);
    expect(a).not.toContain('JBSWY3DPEHPK3PXP');
    expect(box.open(a)).toBe('JBSWY3DPEHPK3PXP');
  });

  it('refuses another key, tampering and malformed values', () => {
    const sealed = new SecretBox(KEY).seal('secret');
    expect(() => new SecretBox('cd'.repeat(32)).open(sealed)).toThrow();
    const [iv, tag, data] = sealed.split('.');
    const flipped = Buffer.from(data!, 'base64url');
    flipped[0] = flipped[0]! ^ 1;
    expect(() =>
      new SecretBox(KEY).open(`${iv}.${tag}.${flipped.toString('base64url')}`),
    ).toThrow();
    expect(() => new SecretBox(KEY).open('nope')).toThrow();
    expect(() => new SecretBox('ab')).toThrow();
  });
});
