import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_THEME, THEME_TOKEN_NAMES } from '@durby/shared';
import { describe, expect, it, vi } from 'vitest';
import { fetchTheme, tokensCss, tokenVariable } from './theme';

const demo = {
  productName: 'Gastro Demo',
  logoUrl: null,
  tokens: { ...DEFAULT_THEME.tokens, primary: '#0f766e' },
};

describe('app/globals.css', () => {
  // The static defaults must be the default theme, so a page renders the same before and after
  // the root layout's theme <style>.
  it('defines every token with the default theme value', () => {
    const css = readFileSync(join(__dirname, '..', 'app', 'globals.css'), 'utf8');
    for (const name of THEME_TOKEN_NAMES) {
      expect(css).toContain(`${tokenVariable(name)}: ${DEFAULT_THEME.tokens[name]};`);
    }
  });
});

describe('tokensCss', () => {
  it('writes every token as a CSS variable', () => {
    const css = tokensCss(demo.tokens);
    expect(css.startsWith(':root{')).toBe(true);
    expect(css).toContain('--primary:#0f766e');
    expect(css).toContain('--muted-foreground:');
    expect(css.match(/--/g)).toHaveLength(THEME_TOKEN_NAMES.length);
  });

  it.each([['red'], ['#fff;}body{display:none'], ['</style><script>'], [42]])(
    'replaces %s with the default token',
    (bad) => {
      const css = tokensCss({ ...demo.tokens, primary: bad });
      expect(css).toContain(`--primary:${DEFAULT_THEME.tokens.primary}`);
      expect(css).not.toMatch(/[<>{}]{2}|script|display/);
    },
  );
});

describe('fetchTheme', () => {
  it('asks the api with the request host and parses the theme', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json(demo));
    // An api without navLayout (older, ADR 0044) means the default sidebar.
    expect(await fetchTheme('partner-demo.localhost:3000', fetchImpl, 'http://api')).toEqual({
      ...demo,
      navLayout: 'default',
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://api/api/v1/theme',
      expect.objectContaining({
        cache: 'no-store',
        headers: { 'X-Forwarded-Host': 'partner-demo.localhost:3000' },
      }),
    );
  });

  it.each([
    ['an unreachable api', () => Promise.reject(new Error('down'))],
    ['an error status', () => Promise.resolve(new Response('', { status: 500 }))],
    ['an unexpected body', () => Promise.resolve(Response.json({ productName: 'X' }))],
  ])('falls back to the default theme on %s', async (_case, impl) => {
    expect(await fetchTheme('x.example.com', vi.fn(impl), 'http://api')).toBe(DEFAULT_THEME);
  });
});
