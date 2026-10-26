import { DEFAULT_THEME } from '@durby/shared';
import { describe, expect, it, vi } from 'vitest';
import type { PlatformPrismaClient } from '../tenancy';
import { THEME_SNAPSHOT_TTL_MS, ThemeService } from './theme.service';

const demoRow = {
  hostname: 'partner-demo.localhost',
  partnerId: 'p1',
  partner: {
    theme: {
      productName: 'Gastro Demo',
      logoPath: null,
      colorPrimary: '#0f766e',
      colorInk: null,
      colorPaper: null,
    },
  },
};

function setup() {
  let now = 0;
  const findMany = vi.fn().mockResolvedValue([demoRow]);
  const prisma = { partnerDomain: { findMany } } as unknown as Pick<
    PlatformPrismaClient,
    'partnerDomain'
  >;
  const service = new ThemeService(prisma, () => now);
  return { service, findMany, advance: (ms: number) => (now += ms) };
}

describe('ThemeService', () => {
  it('loads once and serves lookups from memory until the TTL passes', async () => {
    const { service, findMany, advance } = setup();
    expect((await service.forHost('partner-demo.localhost')).productName).toBe('Gastro Demo');
    await service.forHost('unknown.example.com');
    advance(THEME_SNAPSHOT_TTL_MS - 1);
    await service.forHost('partner-demo.localhost');
    expect(findMany).toHaveBeenCalledTimes(1);
    advance(1);
    await service.forHost('partner-demo.localhost');
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it('shares one refresh between concurrent requests', async () => {
    const { service, findMany } = setup();
    await Promise.all([1, 2, 3].map(() => service.forHost('partner-demo.localhost')));
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it('keeps the previous snapshot when a refresh fails', async () => {
    const { service, findMany, advance } = setup();
    await service.forHost('partner-demo.localhost');
    findMany.mockRejectedValueOnce(new Error('db down'));
    advance(THEME_SNAPSHOT_TTL_MS);
    expect((await service.forHost('partner-demo.localhost')).productName).toBe('Gastro Demo');
  });

  it('serves the default theme when the first load fails, and retries on the next request', async () => {
    const { service, findMany } = setup();
    findMany.mockRejectedValueOnce(new Error('db down'));
    expect(await service.forHost('partner-demo.localhost')).toBe(DEFAULT_THEME);
    expect((await service.forHost('partner-demo.localhost')).productName).toBe('Gastro Demo');
  });
});
