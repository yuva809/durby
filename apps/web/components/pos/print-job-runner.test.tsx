// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { systemRolePermissions } from '@durby/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDeviceSettings } from '../../lib/print/device-settings';
import { setTillLocation } from '../../lib/print/till-location';
import { mockState, resetMocks } from '../../test/mocks';
import { sessionFixture } from '../../test/session-fixture';
import { BrandProvider } from '../theme-provider';
import { PrintJobRunner } from './print-job-runner';

const Runner = () => (
  <BrandProvider brand={{ productName: 'Product', logoUrl: null }}>
    <PrintJobRunner />
  </BrandProvider>
);

vi.mock('../../app/providers', async () => (await import('../../test/mocks')).providersMock());
vi.mock('../../app/labels-provider', async () => (await import('../../test/mocks')).labelsMock());

const app = vi.hoisted(() => ({
  printer: null as null | { print: ReturnType<typeof vi.fn>; [more: string]: unknown },
  drawn: [] as string[],
}));
vi.mock('../../lib/print/native', () => ({ nativePrinter: () => app.printer }));
// jsdom has no canvas: the picture itself is tested in lib/print. Records what was drawn.
vi.mock('../../lib/print/bill-image', () => ({
  preloadBillRenderer: () => Promise.resolve(),
  renderBillImage: vi.fn((el: HTMLElement, widthDots: number) => {
    app.drawn.push(`${widthDots}:${el.textContent ?? ''}`);
    return Promise.resolve({ width: widthDots, height: 1, data: 'A'.repeat(widthDots / 8) });
  }),
}));

const id = (n: number) => `0190a000-0000-7000-8000-0000000005${String(n).padStart(2, '0')}`;
const LOCATION = id(1);
const AT = '2026-11-09T12:00:00.000Z';
const PRINTER = {
  id: id(2),
  locationId: LOCATION,
  name: 'Kitchen',
  host: '192.168.64.22',
  port: 9100,
  widthDots: 576,
  cutter: true,
  imageMode: 'gsV0',
  enabled: true,
  printsBills: false,
  stations: ['kitchen'],
  archivedAt: null,
  createdAt: AT,
  updatedAt: AT,
};
const TICKET = {
  id: id(3),
  sequence: 1,
  kind: 'order',
  station: 'kitchen',
  status: 'new',
  direct: false,
  createdAt: AT,
  lines: [
    {
      id: id(4),
      ticketId: id(3),
      productId: id(5),
      productName: 'Soup',
      quantity: 2,
      unitPrice: '6.90',
      taxRate: '7.00',
      note: 'no onions',
      voidsLineId: null,
      remaining: 2,
      billedQuantity: 0,
      total: '13.80',
      createdAt: AT,
    },
  ],
};
const JOB = {
  id: id(6),
  locationId: LOCATION,
  printerId: PRINTER.id,
  kind: 'ticket',
  orderId: id(7),
  ticketId: TICKET.id,
  checkId: null,
  status: 'claimed',
  stale: false,
  expired: false,
  attempts: 0,
  lastCode: null,
  notBefore: AT,
  expiresAt: '2026-11-09T12:10:00.000Z',
  createdAt: AT,
  claimedAt: AT,
  completedAt: null,
};

function api(order: object) {
  const calls: { method: string; url: string; body: unknown }[] = [];
  let due = [{ id: JOB.id }];
  mockState.store.apiFetch.mockImplementation((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: init?.body ? JSON.parse(init.body as string) : null });
    if (url.startsWith('/api/v1/pos/print-jobs/due')) {
      const answer = Response.json({ data: due });
      due = [];
      return Promise.resolve(answer);
    }
    if (url.endsWith('/claim')) return Promise.resolve(Response.json({ job: JOB }));
    if (url.endsWith('/result'))
      return Promise.resolve(Response.json({ ...JOB, status: 'printed' }));
    if (url.startsWith('/api/v1/pos/bill-layout')) {
      return Promise.resolve(
        Response.json({
          header: { logo: null, name: null, phone: null, email: null, website: null },
          footer: { lines: [] },
          printers: { bill: null },
          printerList: [PRINTER],
        }),
      );
    }
    if (url === `/api/v1/pos/orders/${JOB.orderId}`) return Promise.resolve(Response.json(order));
    if (url.startsWith('/api/v1/settings')) {
      return Promise.resolve(
        Response.json({
          data: [
            { key: 'locale', value: 'en', source: 'default', dataBound: false },
            { key: 'currency', value: 'EUR', source: 'default', dataBound: true },
          ],
        }),
      );
    }
    return Promise.resolve(Response.json({ data: [] }));
  });
  return calls;
}

const ORDER = {
  id: JOB.orderId,
  locationId: LOCATION,
  tableId: id(8),
  tableName: 'T5',
  number: 'ORD-2026-000012',
  status: 'open',
  covers: 2,
  openedAt: AT,
  closedAt: null,
  itemCount: 2,
  gross: '13.80',
  readyCount: 0,
  unbilled: '13.80',
  tickets: [TICKET],
  totals: {
    itemCount: 2,
    gross: '13.80',
    byTaxRate: [{ taxRate: '7.00', gross: '13.80', net: '12.90', tax: '0.90' }],
  },
  waiterName: 'Priya',
  bills: [],
};

beforeEach(() => {
  resetMocks();
  resetDeviceSettings();
  app.printer = null;
  app.drawn = [];
  setTillLocation(null);
  mockState.session = sessionFixture({
    activePermissions: [...systemRolePermissions('waiter')],
    activeFeatures: ['pos'],
  });
});
afterEach(cleanup);

describe('PrintJobRunner (ADR 0033)', () => {
  /** App 1.1 with these device settings. */
  const appWith = (prints: boolean, tillLocationId: string | null) => ({
    print: vi.fn(() => Promise.resolve({ state: 'sent', code: 'print.sent' })),
    has: () => Promise.resolve(true),
    deviceSettings: () =>
      Promise.resolve({
        settings: { prints, tillLocationId, receiptPrinters: {} },
        refused: false,
      }),
  });

  it('never polls on a device with "This device prints" off', async () => {
    app.printer = appWith(false, LOCATION);
    const calls = api(ORDER);
    render(<Runner />);
    act(() => setTillLocation(LOCATION));
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.filter((c) => c.url.includes('/print-jobs'))).toEqual([]);
  });

  it('prints for the location set on This device, before any floor page was open', async () => {
    app.printer = appWith(true, LOCATION);
    const calls = api(ORDER);
    render(<Runner />);
    await waitFor(() =>
      expect(calls.map((c) => c.url)).toContain(
        `/api/v1/pos/print-jobs/due?locationId=${LOCATION}`,
      ),
    );
  });

  it('never polls in a normal browser', async () => {
    api(ORDER);
    act(() => setTillLocation(LOCATION));
    render(<Runner />);
    await new Promise((r) => setTimeout(r, 20));
    expect(mockState.store.apiFetch).not.toHaveBeenCalled();
  });

  it("in the app, prints a due ticket at its printer's width and answers", async () => {
    app.printer = {
      print: vi.fn(() => Promise.resolve({ state: 'sent', code: 'print.sent' })),
    };
    const calls = api(ORDER);
    render(<Runner />);
    // No location yet: nothing to poll until a floor or order page names it.
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.filter((c) => c.url.includes('/print-jobs'))).toEqual([]);
    act(() => setTillLocation(LOCATION));
    await waitFor(() =>
      expect(calls.map((c) => `${c.method} ${c.url}`)).toContain(
        `POST /api/v1/pos/print-jobs/${JOB.id}/result`,
      ),
    );
    expect(calls.find((c) => c.url.endsWith('/result'))!.body).toEqual({ code: 'print.sent' });
    expect(app.printer.print).toHaveBeenCalledWith(expect.any(String), expect.anything(), {
      host: '192.168.64.22',
      port: 9100,
      widthDots: 576,
      cutter: true,
      imageMode: 'gsV0',
    });
    // The kitchen ticket was drawn at 576 dots, with its table and items.
    expect(app.drawn).toHaveLength(1);
    expect(app.drawn[0]).toMatch(/^576:/);
    expect(app.drawn[0]).toContain('T5');
    expect(app.drawn[0]).toContain('Soup');
    expect(app.drawn[0]).toContain('no onions');
  });
});
