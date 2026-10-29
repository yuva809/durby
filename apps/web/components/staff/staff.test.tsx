// @vitest-environment jsdom
import { STAFF_ROLE_PERMISSIONS, type StaffMember, type StaffRole } from '@durby/shared';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import StaffLoginPage from '../../app/platform/login/page';
import { mockState, resetMocks } from '../../test/mocks';
import { BrandProvider } from '../theme-provider';
import { StaffPage } from './staff-page';
import { StaffSessionProvider } from './staff-session';

vi.mock('next/navigation', async () => (await import('../../test/mocks')).navigationMock());

type Answer = () => Response;
let answers: Record<string, Answer | Answer[]>;
const calls: string[] = [];

/** Answers staff api calls by `METHOD path`; an array answers successive calls in order. */
function api(next: Record<string, Answer | Answer[]>) {
  answers = next;
  calls.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${input.replace('/api/v1/platform', '')}`;
      calls.push(key);
      const answer = answers[key];
      const fn = Array.isArray(answer) ? (answer.shift() ?? answer.at(-1)) : answer;
      return Promise.resolve(
        fn ? fn() : Response.json({ code: 'staff.not_found' }, { status: 404 }),
      );
    }),
  );
}

const json =
  (body: unknown, status = 200) =>
  () =>
    Response.json(body, { status });
const empty = () => new Response(null, { status: 204 });
const error = (code: string, status: number) => () => Response.json({ code }, { status });

const ME_ID = '0190a000-0000-7000-8000-000000000001';
const OTHER_ID = '0190a000-0000-7000-8000-000000000002';
const me = (role: StaffRole) =>
  json({
    id: ME_ID,
    email: 'me@durby.tech',
    role,
    permissions: STAFF_ROLE_PERMISSIONS[role],
    freshUntil: null,
  });
const member = (id: string, email: string, role: StaffRole): StaffMember => ({
  id,
  email,
  role,
  status: 'active',
  totpEnrolled: true,
  lastLoginAt: null,
  createdAt: '2026-10-29T10:00:00.000Z',
});
const STAFF = {
  data: [
    member(ME_ID, 'me@durby.tech', 'super_admin'),
    member(OTHER_ID, 'other@durby.tech', 'support'),
  ],
};

beforeEach(resetMocks);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const withSession = (ui: React.ReactNode) =>
  render(
    <BrandProvider brand={{ productName: 'Product', logoUrl: null }}>
      <StaffSessionProvider>{ui}</StaffSessionProvider>
    </BrandProvider>,
  );

describe('staff login', () => {
  it('asks for the password, then a code, and opens the portal', async () => {
    api({
      'GET /auth/me': [error('staff.unauthenticated', 401), me('support')],
      'POST /auth/login': json({ next: 'totp' }),
      'POST /auth/totp': empty,
    });
    withSession(<StaffLoginPage />);
    const form = await screen.findByTestId('staff-login');
    await userEvent.type(within(form).getByRole('textbox'), 'me@durby.tech');
    await userEvent.type(
      within(form).getByLabelText('Password', { exact: true }),
      'secret-password',
    );
    await userEvent.click(within(form).getByRole('button', { name: 'Continue' }));

    await userEvent.type(await screen.findByTestId('staff-code'), '123 456');
    await userEvent.click(screen.getByRole('button', { name: 'Verify' }));
    await waitFor(() => expect(mockState.router.replace).toHaveBeenCalledWith('/platform'));
    expect(calls).toContain('POST /auth/totp');
  });

  it('shows the staff error label', async () => {
    api({
      'GET /auth/me': error('staff.unauthenticated', 401),
      'POST /auth/login': error('staff.invalid_credentials', 401),
    });
    withSession(<StaffLoginPage />);
    const form = await screen.findByTestId('staff-login');
    await userEvent.type(within(form).getByRole('textbox'), 'me@durby.tech');
    await userEvent.type(within(form).getByLabelText('Password', { exact: true }), 'wrong');
    await userEvent.click(within(form).getByRole('button', { name: 'Continue' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Email or password is wrong.');
  });
});

describe('staff page', () => {
  it('is not offered to support staff and loads nothing', async () => {
    api({ 'GET /auth/me': me('support'), 'GET /staff': json(STAFF) });
    withSession(<StaffPage />);
    expect(await screen.findByTestId('staff-no-access')).toBeTruthy();
    expect(calls).not.toContain('GET /staff');
  });

  it('lists staff; super admins can change others but never themselves', async () => {
    api({ 'GET /auth/me': me('super_admin'), 'GET /staff': json(STAFF) });
    withSession(<StaffPage />);
    const rows = await screen.findAllByTestId('staff-row');
    const mine = rows.find((r) => r.dataset.email === 'me@durby.tech')!;
    const other = rows.find((r) => r.dataset.email === 'other@durby.tech')!;
    expect(within(mine).queryByTestId('staff-deactivate')).toBeNull();
    expect(within(mine).queryByTestId('staff-role')).toBeNull();
    expect(within(other).getByTestId('staff-deactivate')).toBeTruthy();
    expect(screen.getByTestId('staff-invite')).toBeTruthy();
  });

  it('asks for password and code when the api needs a fresh confirmation, then retries', async () => {
    api({
      'GET /auth/me': me('super_admin'),
      'GET /staff': json(STAFF),
      [`POST /staff/${OTHER_ID}/deactivate`]: [
        error('staff.reauth_required', 401),
        json({ ...member(OTHER_ID, 'other@durby.tech', 'support'), status: 'deactivated' }),
      ],
      'POST /auth/reauth': empty,
    });
    withSession(<StaffPage />);
    const rows = await screen.findAllByTestId('staff-row');
    const other = rows.find((r) => r.dataset.email === 'other@durby.tech')!;
    await userEvent.click(within(other).getByTestId('staff-deactivate'));
    await userEvent.click(await screen.findByTestId('staff-deactivate-confirm'));

    const dialog = await screen.findByTestId('staff-reauth');
    await userEvent.type(within(dialog).getByLabelText('Password', { exact: true }), 'secret');
    await userEvent.type(within(dialog).getByTestId('staff-code'), '123456');
    await userEvent.click(within(dialog).getByTestId('staff-reauth-confirm'));

    await waitFor(() => expect(screen.queryByTestId('staff-reauth')).toBeNull());
    expect(calls.filter((c) => c === `POST /staff/${OTHER_ID}/deactivate`)).toHaveLength(2);
    expect(calls).toContain('POST /auth/reauth');
  });
});
