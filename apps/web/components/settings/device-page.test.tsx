// @vitest-environment jsdom
import { systemRolePermissions } from '@durby/shared';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDeviceSettings } from '../../lib/print/device-settings';
import { mockState, resetMocks } from '../../test/mocks';
import { sessionFixture } from '../../test/session-fixture';
import { DevicePage } from './device-page';

vi.mock('../../app/providers', async () => (await import('../../test/mocks')).providersMock());
vi.mock('../../app/labels-provider', async () => (await import('../../test/mocks')).labelsMock());
vi.mock('next/navigation', async () => (await import('../../test/mocks')).navigationMock());

const id = (n: number) => `0190a000-0000-7000-8000-0000000007${String(n).padStart(2, '0')}`;
const LOCATION = id(1);
const BRAND = id(2);
const RECEIPT = id(3);
const AT = '2026-11-09T12:00:00.000Z';

type Settings = {
  prints: boolean;
  tillLocationId: string | null;
  receiptPrinters: Record<string, string>;
};

/** App 1.1 holding `settings`; every write is recorded and stored. */
const app = vi.hoisted(() => ({
  printer: null as null | Record<string, unknown>,
  writes: [] as unknown[],
}));
vi.mock('../../lib/print/native', () => ({ nativePrinter: () => app.printer }));

function appWith(settings: Settings, features = ['deviceSettings']) {
  let stored = settings;
  app.printer = {
    has: (f: string) => Promise.resolve(features.includes(f)),
    info: () => Promise.resolve({ type: 'info', appVersion: '1.1.0', protocol: 1, features }),
    deviceSettings: () => Promise.resolve({ settings: stored, refused: false }),
    setDeviceSettings: (next: Settings) => {
      app.writes.push(next);
      stored = next;
      return Promise.resolve({ settings: stored, refused: false });
    },
  };
}

beforeEach(() => {
  resetMocks();
  resetDeviceSettings();
  app.printer = null;
  app.writes = [];
  mockState.session = sessionFixture({
    activePermissions: [...systemRolePermissions('waiter')],
    activeFeatures: ['pos'],
  });
  mockState.store.apiFetch.mockImplementation((url: string) => {
    if (url === '/api/v1/locations')
      return Promise.resolve(
        Response.json({ data: [{ id: LOCATION, name: 'Main', brandId: BRAND }] }),
      );
    if (url.startsWith('/api/v1/pos/bill-layout'))
      return Promise.resolve(
        Response.json({
          header: { logo: null, name: null, phone: null, email: null, website: null },
          footer: { lines: [] },
          printers: { bill: null },
          printerList: [
            {
              id: RECEIPT,
              locationId: LOCATION,
              name: 'Till',
              host: '192.168.64.20',
              port: 9100,
              widthDots: 576,
              cutter: true,
              imageMode: 'gsV0',
              enabled: true,
              printsBills: true,
              stations: [],
              archivedAt: null,
              createdAt: AT,
              updatedAt: AT,
            },
          ],
        }),
      );
    return Promise.resolve(Response.json({ data: [] }));
  });
});
afterEach(cleanup);

describe('DevicePage (Settings → This device)', () => {
  it('shows what the app stored and stores each change in the app', async () => {
    appWith({ prints: true, tillLocationId: LOCATION, receiptPrinters: {} });
    render(<DevicePage />);
    await screen.findByTestId('device-settings');
    expect(screen.getByTestId('device-prints').getAttribute('data-state')).toBe('checked');
    expect((await screen.findByTestId('device-app-version')).textContent).toBe('App version 1.1.0');

    await userEvent.click(screen.getByTestId('device-prints'));
    await waitFor(() =>
      expect(app.writes.at(-1)).toEqual({
        prints: false,
        tillLocationId: LOCATION,
        receiptPrinters: {},
      }),
    );
    expect(screen.getByText('Saved on this device.')).toBeTruthy();

    await userEvent.selectOptions(await screen.findByTestId('device-receipt'), RECEIPT);
    await waitFor(() =>
      expect(app.writes.at(-1)).toEqual({
        prints: false,
        tillLocationId: LOCATION,
        receiptPrinters: { [LOCATION]: RECEIPT },
      }),
    );
  });

  it('says the app must be updated when it cannot keep the settings (app 1.0)', async () => {
    appWith({ prints: true, tillLocationId: null, receiptPrinters: {} }, []);
    render(<DevicePage />);
    expect((await screen.findByTestId('device-settings')).textContent).toContain(
      "This version of the app can't keep these settings",
    );
    expect(screen.getByTestId('device-prints').hasAttribute('disabled')).toBe(true);
  });

  it('outside the app only says where these settings are', () => {
    render(<DevicePage />);
    expect(screen.getByText('These settings exist only in the Android app.')).toBeTruthy();
    expect(mockState.store.apiFetch).not.toHaveBeenCalled();
  });
});
