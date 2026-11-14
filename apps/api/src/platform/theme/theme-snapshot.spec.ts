import { DEFAULT_THEME } from '@durby/shared';
import { describe, expect, it, vi } from 'vitest';
import { buildThemeSnapshot, type DomainThemeRow, themeForHost } from './theme-snapshot';

const demo: DomainThemeRow['theme'] = {
  productName: 'Gastro Demo',
  logoPath: null,
  colorPrimary: '#0f766e',
  colorInk: '#0b1f2a',
  colorPaper: '#f4f8f8',
};

const rows: DomainThemeRow[] = [
  { hostname: 'partner-demo.localhost', partnerId: 'p1', theme: demo },
  { hostname: 'partner-demo.durby.tech', partnerId: 'p1', theme: demo },
  { hostname: 'plain.example.com', partnerId: 'p2', theme: null },
];

describe('buildThemeSnapshot / themeForHost', () => {
  const snapshot = buildThemeSnapshot(rows);

  it('resolves every domain of a partner to the same theme object', () => {
    const a = themeForHost(snapshot, 'partner-demo.localhost');
    expect(a).toMatchObject({ productName: 'Gastro Demo', logoUrl: null });
    expect(a.tokens.primary).toBe('#0f766e');
    expect(themeForHost(snapshot, 'partner-demo.durby.tech')).toBe(a);
  });

  it('normalizes the host (case, port, trailing dot)', () => {
    expect(themeForHost(snapshot, 'Partner-Demo.Localhost:3000').productName).toBe('Gastro Demo');
    expect(themeForHost(snapshot, 'partner-demo.durby.tech.').productName).toBe('Gastro Demo');
  });

  it.each([['unknown.example.com'], ['localhost:3000'], ['127.0.0.1'], [''], [undefined]])(
    'gives %s the one shared default theme',
    (host) => {
      expect(themeForHost(snapshot, host)).toBe(DEFAULT_THEME);
    },
  );

  it('gives a partner without a theme the default theme', () => {
    expect(themeForHost(snapshot, 'plain.example.com')).toBe(DEFAULT_THEME);
  });

  it('adds nothing for looked-up hosts: the snapshot stays the size of partner_domains', () => {
    for (let i = 0; i < 1000; i += 1) themeForHost(snapshot, `random-${i}.example.com`);
    expect(snapshot.size).toBe(rows.length);
  });

  // ADR 0044: the sidebar layout comes from the theme; anything unknown is Durby's menu.
  it('carries the sidebar layout, unknown or missing values as default', () => {
    expect(themeForHost(snapshot, 'partner-demo.localhost').navLayout).toBe('default');
    const s = buildThemeSnapshot([
      { hostname: 'ops.example.com', partnerId: 'p4', theme: { ...demo, navLayout: 'operations' } },
      { hostname: 'odd.example.com', partnerId: 'p5', theme: { ...demo, navLayout: 'fancy' } },
    ]);
    expect(themeForHost(s, 'ops.example.com').navLayout).toBe('operations');
    expect(themeForHost(s, 'odd.example.com').navLayout).toBe('default');
  });

  it('reports a contrast fallback once per partner and keeps the primary', () => {
    const onFallback = vi.fn();
    const bad = { ...demo, colorInk: '#999999', colorPaper: '#ffffff' };
    const s = buildThemeSnapshot(
      [
        { hostname: 'a.example.com', partnerId: 'p3', theme: bad },
        { hostname: 'b.example.com', partnerId: 'p3', theme: bad },
      ],
      onFallback,
    );
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(onFallback).toHaveBeenCalledWith('p3');
    expect(themeForHost(s, 'a.example.com').tokens).toMatchObject({
      primary: '#0f766e',
      foreground: DEFAULT_THEME.tokens.foreground,
    });
  });
});
