import { describe, expect, it, vi } from 'vitest';
import { errorLabel } from '../auth/errors';
import { ActionKey } from '../idempotency';
import { loadMembers, removeMember, updateMember } from './api';

const MEMBER = {
  id: '0190a000-0000-7000-8000-000000000101',
  userId: '0190a000-0000-7000-8000-000000000002',
  email: 'm@example.test',
  role: { id: '0190a000-0000-7000-8000-000000000102', systemKey: 'staff', name: null },
  allLocations: true,
  locationIds: [],
};

const store = (answer: () => Promise<Response>) => ({
  apiFetch: vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(answer),
});

describe('users api: errors become labels, never raw codes or crashes', () => {
  it('parses a list with the shared schema', async () => {
    const s = store(() => Promise.resolve(Response.json({ data: [MEMBER] })));
    expect(await loadMembers(s)).toEqual({ ok: true, data: [MEMBER] });
  });

  it.each([
    ['rbac.last_owner', 409, 'platform.errors.lastOwner'],
    ['rbac.owner_all_locations', 409, 'platform.errors.ownerAllLocations'],
    ['rbac.role_in_use', 409, 'platform.errors.roleInUse'],
    ['rbac.permission_denied', 403, 'platform.errors.permissionDenied'],
    ['rbac.not_grantable', 403, 'platform.errors.notGrantable'],
    ['invitations.already_member', 409, 'platform.invite.errors.alreadyMember'],
  ] as const)('maps %s to its label', async (code, status, label) => {
    const s = store(() => Promise.resolve(Response.json({ code, message: 'x' }, { status })));
    const result = await updateMember(s, new ActionKey(), MEMBER.id, { roleId: MEMBER.role.id });
    expect(result).toEqual({ ok: false, code });
    expect(errorLabel(result.ok ? 'unknown' : result.code)).toBe(label);
  });

  it.each([
    ['an unknown code', () => Response.json({ code: 'something.new' }, { status: 400 })],
    ['a body without a code', () => new Response('<html>Bad gateway</html>', { status: 502 })],
    ['a 2xx body that does not parse', () => Response.json({ data: [{ id: 1 }] })],
  ])('shows the generic message for %s', async (_label, answer) => {
    const result = await loadMembers(store(() => Promise.resolve(answer())));
    const code = result.ok ? null : result.code;
    expect(errorLabel(code as never)).toBe('auth.errors.generic');
  });

  it('turns a network error into the generic message instead of throwing', async () => {
    const s = store(() => Promise.reject(new TypeError('offline')));
    expect(await loadMembers(s)).toEqual({ ok: false, code: 'unknown' });
    expect(await removeMember(s, new ActionKey(), MEMBER.id)).toEqual({
      ok: false,
      code: 'unknown',
    });
  });

  it('sends writes with an Idempotency-Key, reused when the same action is retried', async () => {
    const answers = [
      () => new Response(null, { status: 503 }),
      () => new Response(null, { status: 204 }),
    ];
    const s = store(() => Promise.resolve(answers.shift()!()));
    const action = new ActionKey();
    expect((await removeMember(s, action, MEMBER.id)).ok).toBe(false);
    expect(await removeMember(s, action, MEMBER.id)).toEqual({ ok: true, data: null });
    const keys = s.apiFetch.mock.calls.map(([, init]) =>
      new Headers(init?.headers).get('Idempotency-Key'),
    );
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(keys[1]).toBe(keys[0]);
    expect(s.apiFetch.mock.calls[0]?.[1]?.method).toBe('DELETE');
  });
});
