import { describe, expect, it } from 'vitest';
import { DEFAULT_THEME } from '../theme';
import { themeResponseSchema } from './theme';

describe('themeResponseSchema', () => {
  it('accepts the default theme', () => {
    expect(themeResponseSchema.parse(DEFAULT_THEME)).toEqual(DEFAULT_THEME);
  });

  it('accepts a logo path under /brand', () => {
    const theme = { ...DEFAULT_THEME, logoUrl: '/brand/demo/logo.svg' };
    expect(themeResponseSchema.parse(theme)).toEqual(theme);
  });

  it.each([
    ['a non-hex token', { tokens: { ...DEFAULT_THEME.tokens, primary: 'red' } }],
    ['CSS in a token', { tokens: { ...DEFAULT_THEME.tokens, primary: '#fff;}body{' } }],
    ['an unknown token', { tokens: { ...DEFAULT_THEME.tokens, extra: '#ffffff' } }],
    ['a missing token', { tokens: { ...DEFAULT_THEME.tokens, ring: undefined } }],
    ['an empty product name', { productName: '' }],
    ['an external logo', { logoUrl: 'https://evil.example/logo.svg' }],
    ['a script logo', { logoUrl: 'javascript:alert(1)' }],
  ])('rejects %s', (_case, change) => {
    expect(themeResponseSchema.safeParse({ ...DEFAULT_THEME, ...change }).success).toBe(false);
  });
});
