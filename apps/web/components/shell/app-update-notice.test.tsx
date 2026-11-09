// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkForUpdate, resetAppUpdate } from '../../lib/print/app-update';
import { resetMocks } from '../../test/mocks';
import { AppUpdateNotice } from './app-update-notice';

vi.mock('../../app/labels-provider', async () => (await import('../../test/mocks')).labelsMock());

const app = vi.hoisted(() => ({ printer: null as null | Record<string, unknown> }));
vi.mock('../../lib/print/native', () => ({ nativePrinter: () => app.printer }));

function appWithUpdate(
  versionName: string | null,
  install = vi.fn(() => Promise.resolve('installing')),
) {
  app.printer = {
    has: (f: string) => Promise.resolve(f === 'update'),
    checkUpdate: vi.fn(() => Promise.resolve(versionName ? { versionCode: 3, versionName } : null)),
    installUpdate: install,
  };
  return install;
}

beforeEach(() => {
  resetMocks();
  resetAppUpdate();
  app.printer = null;
});
afterEach(cleanup);

describe('AppUpdateNotice (ADR 0033 §14)', () => {
  it('offers a newer version and installs only when tapped', async () => {
    const install = appWithUpdate('1.1.1');
    render(<AppUpdateNotice />);
    expect((await screen.findByTestId('app-update')).textContent).toContain(
      'A new version of the app is ready: 1.1.1.',
    );
    // A notice in the page, never a dialog that stops service.
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(install).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId('app-update-install'));
    expect(install).toHaveBeenCalledTimes(1);
    expect((await screen.findByTestId('app-update-result')).textContent).toBe(
      'Android now asks you to confirm the update.',
    );
  });

  it('"Later" hides it until the next check', async () => {
    appWithUpdate('1.1.1');
    render(<AppUpdateNotice />);
    await userEvent.click(await screen.findByTestId('app-update-later'));
    expect(screen.queryByTestId('app-update')).toBeNull();
    await act(() => checkForUpdate());
    await waitFor(() => expect(screen.getByTestId('app-update')).toBeTruthy());
  });

  it('shows nothing without a newer version, or outside the app', async () => {
    appWithUpdate(null);
    render(<AppUpdateNotice />);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('app-update')).toBeNull();
    cleanup();
    resetAppUpdate();
    app.printer = null;
    render(<AppUpdateNotice />);
    expect(screen.queryByTestId('app-update')).toBeNull();
  });
});
