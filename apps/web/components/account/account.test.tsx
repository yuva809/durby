// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockState, resetMocks } from '../../test/mocks';
import { sessionFixture } from '../../test/session-fixture';
import { AccountPage } from './account-page';

vi.mock('../../app/providers', async () => (await import('../../test/mocks')).providersMock());
vi.mock('../../app/labels-provider', async () => (await import('../../test/mocks')).labelsMock());
vi.mock('next/navigation', async () => (await import('../../test/mocks')).navigationMock());

beforeEach(() => {
  resetMocks();
  mockState.session = sessionFixture();
});
afterEach(cleanup);

const ME = {
  user: { id: '0190a000-0000-7000-8000-000000000001', email: 'owner@example.test', locale: 'de' },
  organizations: [],
  activeOrganizationId: null,
  activeRole: null,
  activePermissions: [],
  activeFeatures: [],
  passwordChangeRequired: false,
};

describe('/account', () => {
  it('shows the email and the current language; Save waits for a change', () => {
    render(<AccountPage />);
    expect(screen.getByTestId('account-email').textContent).toBe('owner@example.test');
    expect(screen.getByLabelText<HTMLSelectElement>('Language').value).toBe('en');
    expect(screen.getByTestId<HTMLButtonElement>('account-save').disabled).toBe(true);
  });

  it('saves the language, then refreshes the session so the screens switch over', async () => {
    const writes: { method: string; path: string; body: unknown }[] = [];
    mockState.store.apiFetch.mockImplementation((input: string, init?: RequestInit) => {
      writes.push({
        method: init?.method ?? 'GET',
        path: input,
        body: init?.body ? JSON.parse(init.body as string) : null,
      });
      return Promise.resolve(Response.json(ME));
    });
    render(<AccountPage />);
    await userEvent.selectOptions(screen.getByLabelText('Language'), 'de');
    await userEvent.click(screen.getByTestId('account-save'));
    await waitFor(() => expect(mockState.store.refresh).toHaveBeenCalledTimes(1));
    expect(writes).toEqual([{ method: 'PATCH', path: '/api/v1/auth/me', body: { locale: 'de' } }]);
    expect(await screen.findByText('Saved.')).toBeTruthy();
  });

  it('shows the error label and keeps the session when saving fails', async () => {
    mockState.store.apiFetch.mockImplementation(() =>
      Promise.resolve(
        Response.json({ code: 'auth.unauthenticated', message: 'x' }, { status: 401 }),
      ),
    );
    render(<AccountPage />);
    await userEvent.selectOptions(screen.getByLabelText('Language'), 'de');
    await userEvent.click(screen.getByTestId('account-save'));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(mockState.store.refresh).not.toHaveBeenCalled();
  });
});
