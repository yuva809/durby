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
const AT = '2026-11-08T12:00:00.000Z';
const PILOT = {
  host: '192.168.64.20',
  port: 9100,
  widthDots: 576,
  cutter: true,
  imageMode: 'gsV0',
};
const printer = (n: number, locationId: string, overrides: object = {}) => ({
  id: id(40 + n),
  locationId,
  name: `Printer ${n}`,
  ...PILOT,
  enabled: false,
  printsBills: false,
  stations: [],
  archivedAt: null,
  createdAt: AT,
  updatedAt: AT,
  ...overrides,
});

function signedInAs(role: SystemRole) {
  mockState.session = sessionFixture({
    activePermissions: [...systemRolePermissions(role)],
    activeFeatures: ['catalog', 'pos'],
  });
}

/** Printers by location; records the writes and answers them like the api. */
function api(byLocation: Record<string, object[]>) {
  const writes: { method: string; url: string; body: unknown }[] = [];
  mockState.store.apiFetch.mockImplementation((input: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : null;
    if (method !== 'GET') writes.push({ method, url: input, body });
    if (input.startsWith('/api/v1/locations')) {
      return Promise.resolve(Response.json({ data: [MAIN, HARBOUR] }));
    }
    if (method === 'GET' && input.startsWith('/api/v1/pos/printers?')) {
      const location = /locationId=([^&]+)/.exec(input)?.[1] ?? '';
      return Promise.resolve(Response.json({ data: byLocation[location] ?? [] }));
    }
    if (method === 'POST' && input === '/api/v1/pos/printers') {
      const created = printer(9, String(body!.locationId), { ...body });
      byLocation[String(body!.locationId)] = [
        ...(byLocation[String(body!.locationId)] ?? []),
        created,
      ];
      return Promise.resolve(Response.json(created, { status: 201 }));
    }
    const one = /^\/api\/v1\/pos\/printers\/([^/]+)(\/archive)?$/.exec(input);
    if (one) {
      for (const [location, list] of Object.entries(byLocation)) {
        const found = list.find((p) => (p as { id: string }).id === one[1]);
        if (!found) continue;
        const next = one[2]
          ? { ...found, archivedAt: AT, enabled: false }
          : { ...found, ...body, updatedAt: '2026-11-08T12:01:00.000Z' };
        byLocation[location] = one[2]
          ? list.filter((p) => p !== found)
          : list.map((p) => (p === found ? next : p));
        return Promise.resolve(Response.json(next));
      }
    }
    return Promise.resolve(Response.json({ data: [] }));
  });
  return writes;
}

const card = (testId: string) => within(screen.getByTestId(testId));

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

  it("lists each location's printers with what they print and whether they are on", async () => {
    signedInAs('owner');
    api({
      [HARBOUR.id]: [
        printer(1, HARBOUR.id, { name: 'Till', enabled: true, printsBills: true }),
        printer(2, HARBOUR.id, { name: 'Bar', stations: ['kitchen', 'bar'] }),
      ],
    });
    render(<PrintersPage />);
    expect(await screen.findByTestId('printers-none')).toBeTruthy();
    await userEvent.selectOptions(screen.getByTestId('printers-location'), HARBOUR.id);
    const till = await screen.findByTestId(`printers-card-${id(41)}`);
    expect(within(till).getByTestId('printers-state').textContent).toBe('On');
    expect(within(till).getByTestId('printers-bills').getAttribute('aria-checked')).toBe('true');
    const bar = card(`printers-card-${id(42)}`);
    expect(bar.getByTestId('printers-state').textContent).toBe('Off');
    expect(bar.getByTestId('printers-station-kitchen').getAttribute('aria-checked')).toBe('true');
    expect(bar.getByTestId('printers-station-bar').getAttribute('aria-checked')).toBe('true');
  });

  it('adds a printer for a station; it starts switched off (ADR 0033)', async () => {
    signedInAs('owner');
    const writes = api({});
    render(<PrintersPage />);
    await userEvent.click(await screen.findByTestId('printers-add'));
    const added = card('printers-card-new');
    // A new printer can't be switched on before it exists and has had a test print.
    expect(added.queryByTestId('printers-enabled')).toBeNull();
    expect(added.getByTestId<HTMLSelectElement>('printers-paper').value).toBe('576');
    await userEvent.type(added.getByTestId('printers-name'), 'Bar');
    await userEvent.type(added.getByTestId('printers-host'), '192.168.64.20');
    await userEvent.click(added.getByTestId('printers-station-bar'));
    await userEvent.click(added.getByTestId('printers-save'));
    await screen.findByTestId(`printers-card-${id(49)}`);
    expect(writes).toEqual([
      {
        method: 'POST',
        url: '/api/v1/pos/printers',
        body: {
          locationId: MAIN.id,
          name: 'Bar',
          ...PILOT,
          printsBills: false,
          stations: ['bar'],
        },
      },
    ]);
    expect(card(`printers-card-${id(49)}`).getByTestId('printers-state').textContent).toBe('Off');
  });

  it('switches a printer on after its test print, keeping the other cards as they are', async () => {
    signedInAs('owner');
    const writes = api({
      [MAIN.id]: [printer(1, MAIN.id, { name: 'Bar' }), printer(2, MAIN.id, { name: 'Kitchen' })],
    });
    render(<PrintersPage />);
    const kitchen = await screen.findByTestId(`printers-card-${id(42)}`);
    await userEvent.type(within(kitchen).getByTestId('printers-name'), ' 2');
    const bar = card(`printers-card-${id(41)}`);
    await userEvent.click(bar.getByTestId('printers-enabled'));
    await userEvent.click(bar.getByTestId('printers-save'));
    await waitFor(() =>
      expect(card(`printers-card-${id(41)}`).getByTestId('printers-state').textContent).toBe('On'),
    );
    expect(writes).toEqual([
      {
        method: 'PATCH',
        url: `/api/v1/pos/printers/${id(41)}`,
        body: { name: 'Bar', ...PILOT, printsBills: false, stations: [], enabled: true },
      },
    ]);
    // The kitchen card still holds what was typed.
    expect(
      card(`printers-card-${id(42)}`).getByTestId<HTMLInputElement>('printers-name').value,
    ).toBe('Kitchen 2');
  });

  it('archives a printer after asking', async () => {
    signedInAs('owner');
    const writes = api({ [MAIN.id]: [printer(1, MAIN.id, { name: 'Old' })] });
    render(<PrintersPage />);
    const old = await screen.findByTestId(`printers-card-${id(41)}`);
    await userEvent.click(within(old).getByTestId('printers-archive'));
    // The dialog's confirm button (the trigger has the same name).
    const archive = await screen.findAllByRole('button', { name: 'Archive' });
    await userEvent.click(archive.at(-1)!);
    await screen.findByTestId('printers-none');
    expect(writes.map((w) => `${w.method} ${w.url}`)).toEqual([
      `POST /api/v1/pos/printers/${id(41)}/archive`,
    ]);
  });

  it('refuses an address outside the local network before saving', async () => {
    signedInAs('owner');
    const writes = api({});
    render(<PrintersPage />);
    await userEvent.click(await screen.findByTestId('printers-add'));
    const added = card('printers-card-new');
    await userEvent.type(added.getByTestId('printers-name'), 'Bar');
    await userEvent.type(added.getByTestId('printers-host'), '8.8.8.8');
    expect(added.getByText(/Enter a local network address/)).toBeTruthy();
    expect(added.getByTestId<HTMLButtonElement>('printers-save').disabled).toBe(true);
    expect(writes).toEqual([]);
  });

  it("from a browser, sends a printer's test print and Find printer to the till", async () => {
    signedInAs('owner');
    const writes = api({ [MAIN.id]: [printer(1, MAIN.id, { name: 'Kitchen' })] });
    const command = {
      id: id(50),
      locationId: MAIN.id,
      kind: 'find_printers',
      printerId: null,
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
        const body = JSON.parse(init.body as string) as { kind: string; printerId?: string };
        writes.push({ method: 'POST', url: input, body });
        return Promise.resolve(
          Response.json(
            { ...command, kind: body.kind, printerId: body.printerId ?? null },
            { status: 201 },
          ),
        );
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
                  printers: [{ host: '192.168.64.22', port: 9100, status: 'online' }],
                },
              },
            ],
          }),
        );
      }
      return base(input, init);
    });
    render(<PrintersPage />);
    const kitchen = await screen.findByTestId(`printers-card-${id(41)}`);
    expect(screen.queryByTestId('printers-find')).toBeNull();
    await userEvent.click(within(kitchen).getByTestId('printers-test-on-till'));
    expect(writes).toContainEqual({
      method: 'POST',
      url: '/api/v1/pos/printer-commands',
      body: { locationId: MAIN.id, kind: 'test_print', printerId: id(41) },
    });
    // One command at a time: Find printer waits until the till answered the test print.
    await within(kitchen).findByTestId('printers-found', {}, { timeout: 6_000 });
    await userEvent.click(within(kitchen).getByTestId('printers-find-on-till'));
    expect(writes).toContainEqual({
      method: 'POST',
      url: '/api/v1/pos/printer-commands',
      body: { locationId: MAIN.id, kind: 'find_printers' },
    });
    const found = await within(kitchen).findByTestId('printers-found', {}, { timeout: 6_000 });
    await userEvent.click(within(found).getByText('Use'));
    expect(within(kitchen).getByTestId<HTMLInputElement>('printers-host').value).toBe(
      '192.168.64.22',
    );
    // Changed but not saved: the test print waits for the saved printer.
    expect(within(kitchen).getByTestId<HTMLButtonElement>('printers-test-on-till').disabled).toBe(
      true,
    );
  });

  it('in the app, finds printers on the network and test-prints one, naming it', async () => {
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
    await userEvent.click(await screen.findByTestId('printers-add'));
    const added = card('printers-card-new');
    await userEvent.type(added.getByTestId('printers-name'), 'Bar');
    await userEvent.click(added.getByTestId('printers-find'));
    const found = await added.findByTestId('printers-found');
    expect(found.textContent).toContain('Ready');
    expect(found.textContent).toContain('Out of paper');
    await userEvent.click(within(found).getAllByText('Use')[0]!);
    expect(added.getByTestId<HTMLInputElement>('printers-host').value).toBe('192.168.64.20');

    expect(screen.getByTestId('test-print-page').textContent).toContain('Test print: Bar');
    await userEvent.click(added.getByTestId('printers-test'));
    await added.findByText('Sent to the printer.');
    expect(app.printer.print).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ width: 384 }),
      PILOT,
    );
  });

  it('is read-only for those who may read settings but not change them', async () => {
    mockState.session = sessionFixture({
      activePermissions: ['platform.settings.read'],
      activeFeatures: ['pos'],
    });
    api({ [MAIN.id]: [printer(1, MAIN.id)] });
    render(<PrintersPage />);
    const one = await screen.findByTestId(`printers-card-${id(41)}`);
    expect(within(one).getByTestId<HTMLInputElement>('printers-host').disabled).toBe(true);
    expect(screen.queryByTestId('printers-save')).toBeNull();
    expect(screen.queryByTestId('printers-add')).toBeNull();
    expect(screen.queryByTestId('printers-on-till')).toBeNull();
  });
});
