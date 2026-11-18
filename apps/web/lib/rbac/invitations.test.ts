import { describe, expect, it, vi } from 'vitest';
import type { SessionStore } from '../auth/session';
import {
  invitationTokenFromHash,
  joinAsNewUser,
  joinAsSignedIn,
  previewInvitation,
} from './invitations';

const ORG = '01a165d1-ff82-7d5e-8d25-abf61bd10091';
const TOKEN = `${ORG}.${'A'.repeat(43)}`;

const preview = {
  organizationName: 'Bistro',
  email: 'cook@example.test',
  role: { id: ORG, systemKey: 'staff', name: null },
  accountExists: false,
  expiresAt: '2026-10-30T12:00:00.000Z',
};

function storeMock(over: Partial<SessionStore> = {}): SessionStore {
  return {
    get: () => null,
    subscribe: () => () => undefined,
    login: vi.fn().mockResolvedValue({ ok: true }),
    refresh: vi.fn().mockResolvedValue({ ok: true }),
    logout: vi.fn().mockResolvedValue(undefined),
    switchOrganization: vi.fn().mockResolvedValue({ ok: true }),
    changePassword: vi.fn().mockResolvedValue({ ok: true }),
    slot: () => 0,
    selectAccount: vi.fn().mockResolvedValue({ ok: true }),
    logoutSlot: vi.fn().mockResolvedValue(undefined),
    apiFetch: vi.fn(),
    ...over,
  };
}

describe('invitationTokenFromHash', () => {
  it('reads an organization-scoped token from the fragment', () => {
    expect(invitationTokenFromHash(`#token=${TOKEN}`)).toBe(TOKEN);
  });

  it.each(['', '#token=', `#token=${'A'.repeat(43)}`, `#token=${ORG}.short`, `#token=${TOKEN}.x`])(
    'rejects %j',
    (hash) => {
      expect(invitationTokenFromHash(hash)).toBeNull();
    },
  );
});

describe('previewInvitation', () => {
  it('posts the token and parses the preview', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json(preview));
    expect(await previewInvitation(TOKEN, fetchImpl)).toEqual({ ok: true, data: preview });
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/v1/invitations/preview',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ token: TOKEN }) }),
    );
  });

  it('maps errors to their code', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(Response.json({ code: 'auth.token_invalid' }, { status: 400 }));
    expect(await previewInvitation(TOKEN, fetchImpl)).toEqual({
      ok: false,
      code: 'auth.token_invalid',
    });
  });
});

describe('joinAsNewUser', () => {
  const input = { token: TOKEN, email: preview.email, password: 'x'.repeat(12), locale: 'en' };

  it('accepts, signs in with the new password and switches to the organization', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({ organizationId: ORG }));
    const store = storeMock();
    expect(await joinAsNewUser(store, input, fetchImpl)).toEqual({ ok: true, data: ORG });
    expect(store.login).toHaveBeenCalledWith(preview.email, input.password);
    expect(store.switchOrganization).toHaveBeenCalledWith(ORG);
  });

  it('stops before signing in when the email has an account', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(Response.json({ code: 'invitations.sign_in_required' }, { status: 409 }));
    const store = storeMock();
    expect(await joinAsNewUser(store, input, fetchImpl)).toEqual({
      ok: false,
      code: 'invitations.sign_in_required',
    });
    expect(store.login).not.toHaveBeenCalled();
  });
});

describe('joinAsSignedIn', () => {
  it('accepts with the access token and switches to the organization', async () => {
    const apiFetch = vi.fn().mockResolvedValue(Response.json({ organizationId: ORG }));
    const store = storeMock({ apiFetch });
    expect(await joinAsSignedIn(store, TOKEN)).toEqual({ ok: true, data: ORG });
    expect(apiFetch).toHaveBeenCalledWith(
      '/api/v1/invitations/accept-signed-in',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ token: TOKEN }) }),
    );
    expect(store.switchOrganization).toHaveBeenCalledWith(ORG);
  });

  it('reports an email mismatch without switching', async () => {
    const apiFetch = vi
      .fn()
      .mockResolvedValue(Response.json({ code: 'invitations.email_mismatch' }, { status: 403 }));
    const store = storeMock({ apiFetch });
    expect(await joinAsSignedIn(store, TOKEN)).toEqual({
      ok: false,
      code: 'invitations.email_mismatch',
    });
    expect(store.switchOrganization).not.toHaveBeenCalled();
  });
});
