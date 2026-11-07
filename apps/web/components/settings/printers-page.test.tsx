// @vitest-environment jsdom
import { type SystemRole, systemRolePermissions } from '@durby/shared';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { visibleNav } from '../../lib/nav/registry';
import { SETTINGS_TABS } from '../../lib/nav/settings-tabs';
import { mockState, resetMocks } from '../../test/mocks';
import { sessionFixture } from '../../test/session-fixture';
import { PrintersPage } from './printers-page';

vi.mock('../../app/providers', async () => (await import('../../test/mocks')).providersMock());
vi.mock('../../app/labels-provider', async () => (await import('../../test/mocks')).labelsMock());
vi.mock('next/navigation', async () => (await import('../../test/mocks')).navigationMock());

/** The Android app's print object, or none (a browser). */
const app = vi.hoisted(() => ({
  printer: null as null | { discover: ReturnType<typeof vi.fn>; print: ReturnType<typeof vi.fn> },
}));
vi.mock('../../lib/print/native', () => ({ nativePrinter: () => app.printer }));
// jsdom has no canvas: the picture itself is tested in lib/print.
vi.mock('../../lib/print/bill-image', () => ({
  renderBillImage: vi.fn(() => Promise.resolve({ width: 384, height: 1, data: 'A'.repeat(64) })),
}));

beforeEach(() => {
  resetMocks();
  app.printer = null;
});
afterEach(cleanup);

// jsdom has no ResizeObserver; Radix Checkbox measures itself with one.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const id = (n: number) => `0190a000-0000-7000-8000-0000000009${String(n).padStart(2, '0')}`;
const MAIN = { id: id(1), name: 'Main street', brandId: id(90) };
const HARBOUR = { id: id(2), name: 'Harbour', brandId: id(90) };
const PILOT = {
  host: '192.168.64.20',
  port: 9100,
  widthDots: 384,
  cutter: true,
  imageMode: 'gsV0',
};

function signedInAs(role: SystemRole) {
  mockState.session = sessionFixture({
    activePermissions: [...systemRolePermissions(role)],
    activeFeatures: ['catalog', 'pos'],
  });
}

/** `pos.printers` by location id; records the writes. */
function api(byLocation: Record<string, object | null>) {
  const writes: { method: string; url: string; body: unknown }[] = [];
  mockState.store.apiFetch.mockImplementation((input: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (method !== 'GET') {
      const body = init?.body ? (JSON.parse(init.body as string) as { value: unknown }) : null;
      writes.push({ method, url: input, body });
      return Promise.resolve(
        method === 'DELETE'
          ? new Response(null, { status: 204 })
          : Response.json({
              key: 'pos.printers',
              value: body?.value,
              source: 'location',
              dataBound: false,
            }),
      );
    }
    if (input.startsWith('/api/v1/locations')) {
      return Promise.resolve(Response.json({ data: [MAIN, HARBOUR] }));
    }
    if (input.startsWith('/api/v1/settings')) {
      const location = /locationId=([^&]+)/.exec(input)?.[1] ?? '';
      const bill = byLocation[location] ?? null;
      return Promise.resolve(
        Response.json({
          data: [
            {
              key: 'pos.printers',
              value: { bill },
              source: bill ? 'location' : 'default',
              dataBound: false,
            },
          ],
        }),
      );
    }
    return Promise.resolve(Response.json({ data: [] }));
  });
  return writes;
}

describe('PrintersPage', () => {
  it('is a settings tab for those who read settings, with the pos feature', () => {
    const tabs = (role: SystemRole, features: string[]) =>
      visibleNav(SETTINGS_TABS, {
        activePermissions: [...systemRolePermissions(role)],
        activeFeatures: features,
      }).map((tab) => tab.id);
    expect(tabs('owner', ['pos'])).toContain('printers');
    expect(tabs('owner', [])).not.toContain('printers');
  });

  it("shows each location's own printer and saves one for a location", async () => {
    signedInAs('owner');
    const writes = api({ [HARBOUR.id]: PILOT });
    render(<PrintersPage />);
    expect(await screen.findByTestId('printers-not-set')).toBeTruthy();

    await userEvent.selectOptions(screen.getByTestId('printers-location'), HARBOUR.id);
    await waitFor(() =>
      expect(screen.getByTestId<HTMLInputElement>('printers-host').value).toBe('192.168.64.20'),
    );

    await userEvent.selectOptions(screen.getByTestId('printers-location'), MAIN.id);
    await waitFor(() => expect(screen.getByTestId('printers-not-set')).toBeTruthy());
    await userEvent.type(screen.getByTestId('printers-host'), '10.0.0.7');
    await userEvent.selectOptions(screen.getByTestId('printers-paper'), '576');
    await userEvent.click(screen.getByTestId('printers-save'));
    await screen.findByTestId('printers-saved');
    expect(writes).toEqual([
      {
        method: 'PUT',
        url: `/api/v1/settings/pos.printers?locationId=${MAIN.id}`,
        body: {
          value: {
            bill: { host: '10.0.0.7', port: 9100, widthDots: 576, cutter: true, imageMode: 'gsV0' },
          },
        },
      },
    ]);
  });

  it('refuses an address outside the local network before saving', async () => {
    signedInAs('owner');
    const writes = api({});
    render(<PrintersPage />);
    await userEvent.type(await screen.findByTestId('printers-host'), '8.8.8.8');
    expect(screen.getByText(/Enter a local network address/)).toBeTruthy();
    expect(screen.getByTestId<HTMLButtonElement>('printers-save').disabled).toBe(true);
    expect(writes).toEqual([]);
  });

  it('from a browser, sends Find printer to the till and shows what it found', async () => {
    signedInAs('owner');
    const writes = api({});
    const command = {
      id: id(50),
      locationId: MAIN.id,
      kind: 'find_printers',
      status: 'pending',
      expired: false,
      createdAt: '2026-11-07T12:00:00.000Z',
      expiresAt: '2026-11-07T12:05:00.000Z',
      completedAt: null,
      result: null,
    };
    const base = mockState.store.apiFetch.getMockImplementation()!;
    mockState.store.apiFetch.mockImplementation((input: string, init?: RequestInit) => {
      if (input === '/api/v1/pos/printer-commands' && init?.method === 'POST') {
        writes.push({ method: 'POST', url: input, body: JSON.parse(init.body as string) });
        return Promise.resolve(Response.json(command, { status: 201 }));
      }
      if (input.startsWith('/api/v1/pos/printer-commands?')) {
        return Promise.resolve(
          Response.json({
            data: [
              {
                ...command,
                status: 'done',
                completedAt: '2026-11-07T12:00:20.000Z',
                result: {
                  subnet: '192.168.64.0/24',
                  printers: [{ host: '192.168.64.20', port: 9100, status: 'online' }],
                },
              },
            ],
          }),
        );
      }
      return base(input, init);
    });
    render(<PrintersPage />);
    expect(screen.queryByTestId('printers-find')).toBeNull();
    const find = await screen.findByTestId('printers-find-on-till');
    // Nothing saved yet: the test print waits for a saved printer.
    expect(screen.getByTestId<HTMLButtonElement>('printers-test-on-till').disabled).toBe(true);
    await userEvent.click(find);
    expect(writes).toContainEqual({
      method: 'POST',
      url: '/api/v1/pos/printer-commands',
      body: { locationId: MAIN.id, kind: 'find_printers' },
    });
    expect(screen.getByTestId('printers-command-state').textContent).toContain(
      'Waiting for the till',
    );
    const found = await screen.findByTestId('printers-found', {}, { timeout: 6_000 });
    await userEvent.click(within(found).getByText('Use'));
    expect(screen.getByTestId<HTMLInputElement>('printers-host').value).toBe('192.168.64.20');
  });

  it('in the app, finds printers on the network and takes one with a tap, then test-prints it', async () => {
    signedInAs('owner');
    api({});
    app.printer = {
      discover: vi.fn(() =>
        Promise.resolve({
          type: 'discover',
          subnet: '192.168.64.0/24',
          printers: [
            { host: '192.168.64.20', port: 9100, status: 'online' },
            { host: '192.168.64.31', port: 9100, status: 'paper_out' },
          ],
        }),
      ),
      print: vi.fn(() => Promise.resolve({ state: 'sent', code: 'print.sent' })),
    };
    render(<PrintersPage />);
    await userEvent.click(await screen.findByTestId('printers-find'));
    const found = await screen.findByTestId('printers-found');
    expect(found.textContent).toContain('Ready');
    expect(found.textContent).toContain('Out of paper');
    await userEvent.click(within(found).getAllByText('Use')[0]!);
    expect(screen.getByTestId<HTMLInputElement>('printers-host').value).toBe('192.168.64.20');

    await userEvent.click(screen.getByTestId('printers-test'));
    await screen.findByText('Sent to the printer.');
    expect(app.printer.print).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ width: 384 }),
      { host: '192.168.64.20', port: 9100, widthDots: 384, cutter: true, imageMode: 'gsV0' },
    );
  });

  it('is read-only for those who may read settings but not change them', async () => {
    mockState.session = sessionFixture({
      activePermissions: ['platform.settings.read'],
      activeFeatures: ['pos'],
    });
    api({ [MAIN.id]: PILOT });
    render(<PrintersPage />);
    await waitFor(() =>
      expect(screen.getByTestId<HTMLInputElement>('printers-host').disabled).toBe(true),
    );
    expect(screen.queryByTestId('printers-save')).toBeNull();
    expect(screen.queryByTestId('printers-on-till')).toBeNull();
  });
});
