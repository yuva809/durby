import { describe, expect, it, vi } from 'vitest';
import { getHealth } from './api';

const okBody = { status: 'ok', version: '0.0.0', time: '2026-10-21T12:00:00.000Z' };

describe('getHealth', () => {
  it('returns the parsed payload when the API is healthy', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json(okBody));
    await expect(getHealth(fetchImpl, 'http://api.test')).resolves.toEqual(okBody);
    expect(fetchImpl).toHaveBeenCalledWith('http://api.test/api/v1/health', { cache: 'no-store' });
  });

  it('returns null on a non-2xx response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    await expect(getHealth(fetchImpl, 'http://api.test')).resolves.toBeNull();
  });

  it('returns null on an unexpected body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({ status: 'down' }));
    await expect(getHealth(fetchImpl, 'http://api.test')).resolves.toBeNull();
  });

  it('returns null when the API is unreachable', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    await expect(getHealth(fetchImpl, 'http://api.test')).resolves.toBeNull();
  });
});
