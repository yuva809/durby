import { describe, expect, it, vi } from 'vitest';
import { postPublic, tokenFromHash } from './public-requests';

describe('tokenFromHash', () => {
  const token = 'A'.repeat(43);

  it('reads a well-formed token from the fragment', () => {
    expect(tokenFromHash(`#token=${token}`)).toBe(token);
  });

  it.each(['', '#', '#token=', '#token=short', `#other=${token}`, `#token=${token}!`])(
    'rejects %j',
    (hash) => {
      expect(tokenFromHash(hash)).toBeNull();
    },
  );
});

describe('postPublic', () => {
  it('posts JSON same-origin and maps errors to their code', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        Response.json({ code: 'auth.token_invalid', message: 'x' }, { status: 400 }),
      );
    expect(await postPublic('/password/reset', { token: 't', password: 'p' }, fetchImpl)).toEqual({
      ok: false,
      code: 'auth.token_invalid',
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/v1/auth/password/reset',
      expect.objectContaining({ method: 'POST', credentials: 'same-origin' }),
    );
  });

  it('is ok on 2xx without a body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    expect(await postPublic('/password/forgot', { email: 'a@b.test' }, fetchImpl)).toEqual({
      ok: true,
    });
  });
});
