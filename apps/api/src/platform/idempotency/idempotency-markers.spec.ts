import { describe, expect, it } from 'vitest';
import { findIdempotencyMarkerProblems, type IdempotencyRouteInfo } from './idempotency-markers';

const route = (overrides: Partial<IdempotencyRouteInfo>): IdempotencyRouteInfo => ({
  route: 'PUT /api/v1/things/:id',
  method: 'PUT',
  idempotent: undefined,
  exempt: undefined,
  access: [{ kind: 'permission', key: 'platform.settings.manage' }],
  ...overrides,
});

describe('findIdempotencyMarkerProblems', () => {
  it('accepts marked writes and unmarked reads', () => {
    expect(
      findIdempotencyMarkerProblems([
        route({ idempotent: { completion: 'response' } }),
        route({ exempt: 'auth route', access: [{ kind: 'public' }] }),
        route({ route: 'GET /api/v1/things', method: 'GET' }),
      ]),
    ).toEqual([]);
  });

  it('rejects unmarked or doubly marked writes, empty reasons, read markers and non-tenant routes', () => {
    expect(
      findIdempotencyMarkerProblems([
        route({ route: 'POST /a', method: 'POST' }),
        route({ route: 'PUT /b', idempotent: { completion: 'response' }, exempt: 'x' }),
        route({ route: 'DELETE /c', method: 'DELETE', exempt: ' ' }),
        route({ route: 'GET /d', method: 'GET', idempotent: { completion: 'response' } }),
        route({
          route: 'POST /e',
          method: 'POST',
          idempotent: { completion: 'response' },
          access: [{ kind: 'public' }],
        }),
      ]),
    ).toEqual([
      'POST /a: no @Idempotent() or @IdempotencyExempt(reason)',
      'PUT /b: both @Idempotent() and @IdempotencyExempt()',
      'DELETE /c: @IdempotencyExempt needs a reason',
      'GET /d: idempotency marker on a read route',
      'POST /e: @Idempotent() needs @RequirePermission (a tenant-scoped route)',
    ]);
  });
});
