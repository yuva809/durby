import { describe, expect, it } from 'vitest';
import { apiErrorBodySchema } from './errors';

describe('apiErrorBodySchema', () => {
  it('reads the code of an api error, with or without message and details', () => {
    expect(
      apiErrorBodySchema.parse({ code: 'rbac.last_owner', message: 'x', details: { a: 1 } }),
    ).toEqual({
      code: 'rbac.last_owner',
      message: 'x',
      details: { a: 1 },
    });
    expect(apiErrorBodySchema.parse({ code: 'idempotency.request_in_progress' }).code).toBe(
      'idempotency.request_in_progress',
    );
  });

  it.each([[{}], [{ code: 7 }], [{ code: '' }], [['rbac.last_owner']], [null], ['text']])(
    'rejects %j',
    (body) => {
      expect(apiErrorBodySchema.safeParse(body).success).toBe(false);
    },
  );
});
