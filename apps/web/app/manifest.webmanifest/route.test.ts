// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const theme = vi.hoisted(() => ({
  fetchTheme: vi.fn(),
}));
vi.mock('../../lib/theme', () => ({ fetchTheme: theme.fetchTheme }));
vi.mock('next/headers', () => ({
  headers: () => Promise.resolve(new Headers({ host: 'app.example.test' })),
}));

import { GET } from './route';

beforeEach(() => theme.fetchTheme.mockReset());

describe('/manifest.webmanifest (ADR 0072)', () => {
  it('names the app after the partner, starts at the till, and uses the partner logo as icon', async () => {
    theme.fetchTheme.mockResolvedValue({
      productName: 'Partner Till',
      logoUrl: '/brand/logo.webp',
    });
    const res = await GET();
    expect(theme.fetchTheme).toHaveBeenCalledWith('app.example.test');
    expect(res.headers.get('Content-Type')).toBe('application/manifest+json');
    const body: unknown = await res.json();
    expect(body).toEqual({
      name: 'Partner Till',
      short_name: 'Partner Till',
      start_url: '/service',
      scope: '/',
      display: 'standalone',
      icons: [{ src: '/brand/logo.webp', sizes: 'any' }],
    });
  });

  it('has no icons when the partner has no logo', async () => {
    theme.fetchTheme.mockResolvedValue({ productName: 'Partner Till', logoUrl: null });
    const body = (await (await GET()).json()) as { icons: unknown[] };
    expect(body.icons).toEqual([]);
  });
});
