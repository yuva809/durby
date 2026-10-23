import { describe, expect, it } from 'vitest';
import {
  AA_NON_TEXT,
  AA_TEXT,
  contrastRatio,
  DEFAULT_COLORS,
  DEFAULT_THEME,
  deriveThemeTokens,
  mix,
  normalizeHost,
  resolveThemeColors,
  type ThemeTokens,
} from './theme';

/** The pairs the web app renders (docs/platform/web-shell.md → Tokens). */
function contrastProblems(t: ThemeTokens): string[] {
  const text: [string, string, string][] = [
    ['foreground', 'background', t.foreground],
    ['foreground', 'card', t.foreground],
    ['foreground', 'muted', t.foreground],
    ['mutedForeground', 'background', t.mutedForeground],
    ['mutedForeground', 'card', t.mutedForeground],
    ['mutedForeground', 'muted', t.mutedForeground],
    ['primaryText', 'background', t.primaryText],
    ['primaryText', 'card', t.primaryText],
    ['primaryText', 'muted', t.primaryText],
    ['destructive', 'background', t.destructive],
    ['destructive', 'card', t.destructive],
  ];
  const surfaces: Record<string, string> = {
    background: t.background,
    card: t.card,
    muted: t.muted,
  };
  const problems = text
    .filter(([, on, color]) => contrastRatio(color, surfaces[on] ?? '') < AA_TEXT)
    .map(([name, on]) => `${name} on ${on}`);
  if (contrastRatio(t.primaryForeground, t.primary) < AA_TEXT)
    problems.push('primaryForeground on primary');
  for (const on of ['background', 'card'] as const) {
    if (contrastRatio(t.ring, t[on]) < AA_NON_TEXT) problems.push(`ring on ${on}`);
    if (contrastRatio(t.input, t[on]) < AA_NON_TEXT) problems.push(`input on ${on}`);
  }
  return problems;
}

describe('contrastRatio', () => {
  it('matches the WCAG reference values', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#ffffff')).toBe(1);
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 2);
  });

  // docs/platform/web-shell.md → WCAG AA table.
  it('gives the documented ratios for the Durby palette', () => {
    const { ink, primary: ember, paper } = DEFAULT_COLORS;
    expect(contrastRatio(ink, paper)).toBeCloseTo(17.3, 1);
    expect(contrastRatio(ember, paper)).toBeCloseTo(2.9, 1);
    expect(contrastRatio(ink, ember)).toBeCloseTo(5.9, 1);
    expect(contrastRatio('#ffffff', ember)).toBeCloseTo(3.1, 1);
  });
});

describe('mix', () => {
  it('interpolates in sRGB', () => {
    expect(mix('#000000', '#ffffff', 0)).toBe('#000000');
    expect(mix('#000000', '#ffffff', 1)).toBe('#ffffff');
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080');
  });
});

describe('deriveThemeTokens', () => {
  it('keeps the Durby palette and fixes its weak pairs', () => {
    const t = deriveThemeTokens(DEFAULT_COLORS);
    expect(t).not.toBeNull();
    expect(t).toMatchObject({ background: '#fbf8f3', foreground: '#17140f', primary: '#ff5a1f' });
    // Ember is too light for text or a ring on Paper; Ink (not white) goes on Ember buttons.
    expect(t?.primaryForeground).toBe('#17140f');
    expect(t?.primaryText).not.toBe('#ff5a1f');
    expect(contrastProblems(t as ThemeTokens)).toEqual([]);
  });

  it('puts white on the demo teal', () => {
    const t = deriveThemeTokens({ primary: '#0f766e', ink: '#0b1f2a', paper: '#f4f8f8' });
    expect(t?.primaryForeground).toBe('#ffffff');
    expect(t?.primaryText).toBe('#0f766e');
    expect(contrastProblems(t as ThemeTokens)).toEqual([]);
  });

  it('reaches AA for any primary across hue and lightness', () => {
    const failures: string[] = [];
    for (let r = 0; r <= 255; r += 17) {
      for (let g = 0; g <= 255; g += 17) {
        for (let b = 0; b <= 255; b += 17) {
          const primary = `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
          for (const base of [DEFAULT_COLORS, { ink: '#0b1f2a', paper: '#f4f8f8' }]) {
            const t = deriveThemeTokens({ ...base, primary });
            if (!t) failures.push(`${primary}: null`);
            else failures.push(...contrastProblems(t).map((p) => `${primary}: ${p}`));
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it.each([
    ['ink too light for paper', { primary: '#ff5a1f', ink: '#999999', paper: '#ffffff' }],
    ['dark paper', { primary: '#ff5a1f', ink: '#17140f', paper: '#222222' }],
    ['a malformed color', { primary: 'red' }],
  ])('returns null for %s', (_case, colors) => {
    expect(deriveThemeTokens(colors)).toBeNull();
  });

  it('uses the default ink and paper when they are null', () => {
    expect(deriveThemeTokens({ primary: '#ff5a1f', ink: null, paper: null })).toEqual(
      deriveThemeTokens(DEFAULT_COLORS),
    );
  });
});

describe('resolveThemeColors', () => {
  it('falls back to the default ink and paper, keeping the primary', () => {
    const { tokens, fallback } = resolveThemeColors({
      primary: '#0f766e',
      ink: '#999999',
      paper: '#ffffff',
    });
    expect(fallback).toBe(true);
    expect(tokens).toMatchObject({
      primary: '#0f766e',
      foreground: '#17140f',
      background: '#fbf8f3',
    });
    expect(contrastProblems(tokens)).toEqual([]);
  });

  it('falls back to the default primary when it is malformed', () => {
    expect(resolveThemeColors({ primary: 'red' })).toEqual({
      tokens: DEFAULT_THEME.tokens,
      fallback: true,
    });
  });
});

describe('normalizeHost', () => {
  it.each([
    ['partner-demo.localhost', 'partner-demo.localhost'],
    ['Partner-Demo.LOCALHOST:3000', 'partner-demo.localhost'],
    ['staging.durby.tech.', 'staging.durby.tech'],
    ['  staging.durby.tech  ', 'staging.durby.tech'],
  ])('%s → %s', (raw, host) => {
    expect(normalizeHost(raw)).toBe(host);
  });

  it.each([
    [undefined],
    [''],
    ['localhost'],
    ['localhost:3000'],
    ['127.0.0.1'],
    ['127.0.0.1:4000'],
    ['[::1]:3000'],
    ['evil.example.com/x'],
    ['evil_host.example.com'],
    ['-evil.example.com'],
    [`${'a'.repeat(64)}.example.com`],
    [`${'a.'.repeat(126)}com`],
    ['a.b:99999999'],
  ])('%s → null', (raw) => {
    expect(normalizeHost(raw)).toBeNull();
  });
});
