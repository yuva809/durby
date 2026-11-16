// @vitest-environment jsdom
import { STAFF_ROLE_PERMISSIONS, type StaffRole, systemRolePermissions } from '@durby/shared';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockState, resetMocks } from '../../test/mocks';
import { sessionFixture } from '../../test/session-fixture';
import { StaffFeedbackPage } from '../staff/feedback-page';
import { StaffSessionProvider } from '../staff/staff-session';
import { FeedbackPage } from './feedback-page';

vi.mock('../../app/providers', async () => (await import('../../test/mocks')).providersMock());
vi.mock('../../app/labels-provider', async () => (await import('../../test/mocks')).labelsMock());
vi.mock('next/navigation', async () => (await import('../../test/mocks')).navigationMock());

beforeEach(resetMocks);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const id = (n: number) => `0190a000-0000-7000-8000-0000000009${String(n).padStart(2, '0')}`;
const item = (n: number, status = 'new') => ({
  id: id(n),
  category: 'idea',
  message: `Message ${n}`,
  pagePath: null,
  status,
  createdAt: '2026-11-16T09:00:00.000Z',
});

describe('Feedback (/feedback)', () => {
  it('sends the message with its category and the page it came from, then lists it', async () => {
    mockState.session = sessionFixture({
      activePermissions: [...systemRolePermissions('waiter')],
    });
    mockState.search = 'from=/checkout';
    const calls: { method: string; body: unknown }[] = [];
    let sent = false;
    mockState.store.apiFetch.mockImplementation((_input: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ method, body: init?.body ? JSON.parse(init.body as string) : null });
      if (method === 'POST') {
        sent = true;
        return Promise.resolve(Response.json(item(1)));
      }
      return Promise.resolve(Response.json({ data: sent ? [item(1)] : [] }));
    });
    render(<FeedbackPage />);
    expect(await screen.findByText('Nothing sent yet.')).toBeTruthy();
    await userEvent.click(screen.getByTestId('feedback-send'));
    expect(await screen.findByText('Write a few words first.')).toBeTruthy();

    await userEvent.click(screen.getByTestId('feedback-category-bug'));
    await userEvent.type(screen.getByTestId('feedback-message'), 'The printer stops.');
    await userEvent.click(screen.getByTestId('feedback-send'));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
        category: 'bug',
        message: 'The printer stops.',
        pagePath: '/checkout',
      }),
    );
    expect(await screen.findByTestId('feedback-history')).toBeTruthy();
    expect(screen.getByText('Thank you. Your feedback is on its way to the team.')).toBeTruthy();
  });

  it('shows no access without platform.feedback.send', () => {
    mockState.session = sessionFixture({ activePermissions: [] });
    render(<FeedbackPage />);
    expect(screen.queryByTestId('feedback-send')).toBeNull();
  });
});

describe('Feedback in the admin portal (/platform/feedback)', () => {
  function staffApi(role: StaffRole) {
    const calls: { key: string; body: unknown }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string, init?: RequestInit) => {
        const key = `${init?.method ?? 'GET'} ${input.replace('/api/v1/platform', '')}`;
        calls.push({ key, body: typeof init?.body === 'string' ? JSON.parse(init.body) : null });
        if (key === 'GET /auth/me') {
          return Promise.resolve(
            Response.json({
              id: id(90),
              email: 'me@durby.tech',
              role,
              permissions: STAFF_ROLE_PERMISSIONS[role],
              freshUntil: null,
            }),
          );
        }
        const staffItem = {
          ...item(2),
          organizationId: id(80),
          organizationName: 'AsiaMight',
          userEmail: 'owner@asiamight.example',
          updatedAt: '2026-11-16T09:00:00.000Z',
        };
        if (key.startsWith('PATCH /feedback/')) {
          return Promise.resolve(Response.json({ ...staffItem, status: 'done' }));
        }
        if (key.startsWith('GET /feedback'))
          return Promise.resolve(Response.json({ data: [staffItem] }));
        return Promise.resolve(Response.json({ code: 'unknown' }, { status: 500 }));
      }),
    );
    return calls;
  }

  it('lists new feedback with the customer and marks it done', async () => {
    const calls = staffApi('support');
    render(
      <StaffSessionProvider>
        <StaffFeedbackPage />
      </StaffSessionProvider>,
    );
    const card = await screen.findByTestId('staff-feedback-item');
    expect(within(card).getByText('AsiaMight')).toBeTruthy();
    expect(within(card).getByText(/owner@asiamight\.example/)).toBeTruthy();
    expect(calls.some((c) => c.key === 'GET /feedback?status=new')).toBe(true);
    await userEvent.click(within(card).getByTestId('staff-feedback-mark-done'));
    await waitFor(() =>
      expect(calls.find((c) => c.key === `PATCH /feedback/${id(2)}`)?.body).toEqual({
        status: 'done',
      }),
    );
  });

  it('is read-only for onboarding', async () => {
    staffApi('onboarding');
    render(
      <StaffSessionProvider>
        <StaffFeedbackPage />
      </StaffSessionProvider>,
    );
    const card = await screen.findByTestId('staff-feedback-item');
    expect(within(card).queryByTestId('staff-feedback-mark-done')).toBeNull();
  });
});
