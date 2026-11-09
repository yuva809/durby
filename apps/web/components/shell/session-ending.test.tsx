// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockState, resetMocks } from '../../test/mocks';
import { sessionFixture } from '../../test/session-fixture';
import { SessionEnding, sessionDaysLeft } from './session-ending';

vi.mock('../../app/providers', async () => (await import('../../test/mocks')).providersMock());
vi.mock('../../app/labels-provider', async () => (await import('../../test/mocks')).labelsMock());
vi.mock('next/navigation', async () => (await import('../../test/mocks')).navigationMock());

beforeEach(resetMocks);
afterEach(cleanup);

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-11-09T12:00:00Z');
const at = (ms: number) => new Date(NOW + ms).toISOString();

describe('sessionDaysLeft', () => {
  it('is null until 3 days before the end, and without a known end', () => {
    expect(sessionDaysLeft(at(3 * DAY + 1), NOW)).toBeNull();
    expect(sessionDaysLeft(undefined, NOW)).toBeNull();
  });

  it('counts whole days, rounded up, at least one', () => {
    expect(sessionDaysLeft(at(3 * DAY), NOW)).toBe(3);
    expect(sessionDaysLeft(at(2 * DAY + 1), NOW)).toBe(3);
    expect(sessionDaysLeft(at(DAY), NOW)).toBe(1);
    expect(sessionDaysLeft(at(60_000), NOW)).toBe(1);
  });
});

describe('SessionEnding', () => {
  it('shows nothing while the end is far', () => {
    mockState.session = sessionFixture({
      sessionExpiresAt: new Date(Date.now() + 20 * DAY).toISOString(),
    });
    render(<SessionEnding />);
    expect(screen.queryByTestId('session-ending')).toBeNull();
  });

  it('asks to sign in again; the button signs out and opens sign-in with the password', async () => {
    mockState.session = sessionFixture({
      sessionExpiresAt: new Date(Date.now() + 2.5 * DAY).toISOString(),
    });
    mockState.pathname = '/service';
    render(<SessionEnding />);
    expect(screen.getByTestId('session-ending').textContent).toContain(
      'Please sign in again soon: your sign-in ends in 3 days.',
    );
    await userEvent.click(screen.getByTestId('session-sign-in-again'));
    expect(mockState.store.logout).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(mockState.router.replace).toHaveBeenCalledWith(expect.stringMatching(/^\/login/)),
    );
  });
});
