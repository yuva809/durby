import { describe, expect, it } from 'vitest';
import { asJson, findSecretKey, isStoredStatus, requestHash } from './storage-policy';

describe('requestHash', () => {
  it('ignores key order in the body but not values, method or URL', () => {
    const base = requestHash('put', '/api/v1/settings/timezone', { value: 'UTC', a: 1 });
    expect(requestHash('PUT', '/api/v1/settings/timezone', { a: 1, value: 'UTC' })).toBe(base);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(requestHash('PUT', '/api/v1/settings/timezone', { a: 1, value: 'CET' })).not.toBe(base);
    expect(requestHash('DELETE', '/api/v1/settings/timezone', { a: 1, value: 'UTC' })).not.toBe(
      base,
    );
    expect(
      requestHash('PUT', '/api/v1/settings/timezone?locationId=x', { a: 1, value: 'UTC' }),
    ).not.toBe(base);
  });

  it('treats a missing body like null', () => {
    expect(requestHash('DELETE', '/x', undefined)).toBe(requestHash('DELETE', '/x', null));
  });
});

describe('isStoredStatus', () => {
  it('stores 2xx and decided 4xx, not access, timing, limits or 5xx', () => {
    expect([200, 201, 204, 400, 404, 409, 422].every(isStoredStatus)).toBe(true);
    expect([401, 403, 408, 429, 500, 502, 503].some(isStoredStatus)).toBe(false);
  });
});

describe('findSecretKey', () => {
  it('finds token- or secret-like keys, also nested and in arrays', () => {
    expect(findSecretKey({ id: '1', name: 'x' })).toBeNull();
    expect(findSecretKey({ accessToken: 'x' })).toBe('accessToken');
    expect(findSecretKey({ data: [{ id: 1 }, { inner: { client_secret: 'x' } }] })).toBe(
      'client_secret',
    );
    expect(findSecretKey({ password: 'x' })).toBe('password');
    expect(findSecretKey(null)).toBeNull();
  });
});

describe('asJson', () => {
  it('is what the client receives', () => {
    expect(asJson(undefined)).toBeNull();
    expect(asJson({ at: new Date('2026-01-01T00:00:00Z'), skip: undefined })).toEqual({
      at: '2026-01-01T00:00:00.000Z',
    });
  });
});
