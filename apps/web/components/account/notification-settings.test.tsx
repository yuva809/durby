// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockState, resetMocks } from '../../test/mocks';
import { sessionFixture } from '../../test/session-fixture';
import { NotificationSettings } from './notification-settings';

vi.mock('../../app/providers', async () => (await import('../../test/mocks')).providersMock());
vi.mock('../../app/labels-provider', async () => (await import('../../test/mocks')).labelsMock());
vi.mock('next/navigation', async () => (await import('../../test/mocks')).navigationMock());

beforeEach(resetMocks);
afterEach(cleanup);

const PREFS = [
  { kind: 'request_submitted', email: true, push: false },
  { kind: 'low_stock', email: false, push: false },
];

describe('/account/notifications (ADR 0047)', () => {
  it('shows each kind with its choices and saves only what changed', async () => {
    mockState.session = sessionFixture();
    mockState.store.apiFetch.mockImplementation((_path: string, init?: RequestInit) =>
      Promise.resolve(
        Response.json({
          data:
            init?.method === 'PUT'
              ? [PREFS[0], { kind: 'low_stock', email: true, push: false }]
              : PREFS,
        }),
      ),
    );
    render(<NotificationSettings />);
    const rows = await screen.findAllByTestId('pref-row');
    expect(rows.map((r) => r.textContent)).toEqual([
      'A branch asks for stock',
      'An item drops to its reorder level',
    ]);
    expect(screen.getByTestId('pref-request_submitted-email').getAttribute('data-state')).toBe(
      'checked',
    );
    const save = screen.getByTestId('notification-settings-save');
    expect((save as HTMLButtonElement).disabled).toBe(true);

    await userEvent.click(screen.getByTestId('pref-low_stock-email'));
    await userEvent.click(save);
    await waitFor(() =>
      expect(mockState.store.apiFetch).toHaveBeenCalledWith(
        '/api/v1/notifications/preferences',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({
            preferences: [{ kind: 'low_stock', email: true, push: false }],
          }),
        }),
      ),
    );
    expect(await screen.findByText('Saved.')).toBeTruthy();
  });
});
