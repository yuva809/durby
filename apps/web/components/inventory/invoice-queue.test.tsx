// @vitest-environment jsdom
import { systemRolePermissions, type VendorInvoice } from '@durby/shared';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockState, resetMocks } from '../../test/mocks';
import { sessionFixture } from '../../test/session-fixture';
import { InvoiceQueuePage } from './invoice-queue-page';

vi.mock('../../app/providers', async () => (await import('../../test/mocks')).providersMock());
vi.mock('../../app/labels-provider', async () => (await import('../../test/mocks')).labelsMock());
vi.mock('next/navigation', async () => (await import('../../test/mocks')).navigationMock());

beforeEach(resetMocks);
afterEach(cleanup);

const id = (n: number) => `0190a000-0000-7000-8000-0000000052${String(n).padStart(2, '0')}`;
const WAREHOUSE = {
  id: id(1),
  locationId: id(2),
  name: 'Main Warehouse',
  sortOrder: 0,
  suppliesStation: null,
  isTransit: false,
  archivedAt: null,
};
const CATFISH = {
  id: id(3),
  name: 'Catfish 4kg',
  sku: '1103-002',
  unit: 'pc',
  minQuantity: null,
  parentItemId: null,
  variantValues: [],
  salePrice: null,
  categoryId: null,
  archivedAt: null,
};

function invoice(status: VendorInvoice['status'] = 'pending'): VendorInvoice {
  return {
    id: id(9),
    number: 'VIN-2026-000001',
    status,
    warehouseId: WAREHOUSE.id,
    warehouseName: WAREHOUSE.name,
    supplier: 'Bonesca',
    invoiceNumber: '108666',
    invoiceDate: '10-11-2026',
    lineCount: 2,
    newItemCount: 1,
    total: '1795.00',
    printedTotal: '1795.00',
    submittedByName: 'Ravi',
    createdAt: '2026-11-18T10:00:00.000Z',
    decidedAt: status === 'pending' ? null : '2026-11-18T11:00:00.000Z',
    note: null,
    fileName: '108666.pdf',
    source: 'pdf',
    rejectReason: status === 'rejected' ? 'Wrong prices' : null,
    decidedByName: status === 'pending' ? null : 'Mia',
    documentId: status === 'approved' ? id(10) : null,
    documentNumber: status === 'approved' ? 'GR-2026-000012' : null,
    lines: [
      {
        id: id(11),
        position: 1,
        code: '1103-002',
        description: 'Bigi Mama African Catfish 1 x 4kg',
        itemId: CATFISH.id,
        itemName: CATFISH.name,
        newItem: null,
        itemDetails: null,
        unitId: null,
        unitSymbol: null,
        quantity: '50.000',
        unitCost: '11.0000',
        value: '550.00',
      },
      {
        id: id(12),
        position: 2,
        code: '1971-002',
        description: 'OD Yellow Croakers 5 x 2kg',
        itemId: null,
        itemName: null,
        newItem: {
          name: 'OD Yellow Croakers 5 x 2kg',
          sku: '1971-002',
          unit: 'pc',
          categoryId: null,
          brand: null,
          packCount: 5,
          packSize: '2.000',
          packUnit: 'kg',
        },
        itemDetails: null,
        unitId: null,
        unitSymbol: null,
        quantity: '30.000',
        unitCost: '41.5000',
        value: '1245.00',
      },
    ],
  };
}

/** The api: the queue holds one invoice; writes are recorded and answered with it in its new status. */
function api(start: VendorInvoice = invoice()) {
  let current = start;
  const writes: { method: string; path: string; body: unknown }[] = [];
  mockState.store.apiFetch.mockImplementation((input: string, init?: RequestInit) => {
    const [path, query = ''] = input.split('?');
    const method = init?.method ?? 'GET';
    if (method !== 'GET') {
      const body: unknown = init?.body ? JSON.parse(init.body as string) : undefined;
      writes.push({ method, path: path!, body });
      if (path!.endsWith('/approve')) current = invoice('approved');
      if (path!.endsWith('/reject')) current = invoice('rejected');
      return Promise.resolve(Response.json(current));
    }
    if (path === '/api/v1/inventory/invoices') {
      const status = new URLSearchParams(query).get('status');
      const { lines: _lines, ...summary } = current;
      void _lines;
      return Promise.resolve(Response.json({ data: current.status === status ? [summary] : [] }));
    }
    if (path === `/api/v1/inventory/invoices/${current.id}`) {
      return Promise.resolve(Response.json(current));
    }
    const answers: Record<string, unknown> = {
      '/api/v1/inventory/warehouses': { data: [WAREHOUSE] },
      '/api/v1/inventory/items': { data: [CATFISH] },
      '/api/v1/settings': {
        data: [
          { key: 'locale', value: 'en', source: 'default', dataBound: false },
          { key: 'currency', value: 'EUR', source: 'default', dataBound: true },
        ],
      },
    };
    return Promise.resolve(Response.json(answers[path!] ?? { data: [] }));
  });
  return writes;
}

function signedIn(permissions = [...systemRolePermissions('owner')]) {
  mockState.session = sessionFixture({
    activePermissions: permissions,
    activeFeatures: ['inventory', 'orders'],
  });
}

describe('/inventory/invoices (ADR 0054)', () => {
  it('lists pending invoices; an approver opens one, corrects it, and approving saves first', async () => {
    signedIn();
    const writes = api();
    render(<InvoiceQueuePage />);
    const card = await screen.findByTestId('queue-item');
    expect(card.textContent).toContain('Bonesca');
    expect(card.textContent).toContain('VIN-2026-000001');
    await userEvent.click(card);

    const lines = await screen.findAllByTestId('invoice-line');
    expect(within(lines[0]!).getByTestId<HTMLInputElement>('invoice-line-quantity').value).toBe(
      '50',
    );
    await userEvent.clear(within(lines[0]!).getByTestId('invoice-line-quantity'));
    await userEvent.type(within(lines[0]!).getByTestId('invoice-line-quantity'), '48');
    expect(screen.getByTestId('queue-save')).toBeTruthy();

    await userEvent.click(screen.getByTestId('queue-approve'));
    await userEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Approve and book',
      }),
    );
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[0]).toMatchObject({
      method: 'PUT',
      path: `/api/v1/inventory/invoices/${id(9)}`,
      body: {
        warehouseId: WAREHOUSE.id,
        supplier: 'Bonesca',
        invoiceNumber: '108666',
        source: 'pdf',
        lines: [
          { itemId: CATFISH.id, quantity: '48', unitCost: '11.00' },
          { newItem: { name: 'OD Yellow Croakers 5 x 2kg', sku: '1971-002' }, quantity: '30' },
        ],
      },
    });
    expect(writes[1]).toEqual({
      method: 'POST',
      path: `/api/v1/inventory/invoices/${id(9)}/approve`,
      body: undefined,
    });
    expect(
      (await screen.findByText(/booked as goods receipt GR-2026-000012/)).textContent,
    ).toContain('Mia');
    expect(screen.queryByTestId('queue-approve')).toBeNull();
  });

  it('rejects with a reason', async () => {
    signedIn();
    mockState.search = `open=${id(9)}`;
    const writes = api();
    render(<InvoiceQueuePage />);
    await userEvent.click(await screen.findByTestId('queue-reject'));
    await userEvent.type(await screen.findByTestId('queue-reject-reason'), 'Wrong prices');
    await userEvent.click(screen.getByTestId('form-save'));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toEqual({
      method: 'POST',
      path: `/api/v1/inventory/invoices/${id(9)}/reject`,
      body: { reason: 'Wrong prices' },
    });
    expect(await screen.findByText(/Rejected by Mia: Wrong prices/)).toBeTruthy();
  });

  it('shows the queue without approve or reject to someone who only receives goods', async () => {
    signedIn(['inventory.stock.read', 'inventory.stock.receive']);
    mockState.search = `open=${id(9)}`;
    api();
    render(<InvoiceQueuePage />);
    expect(await screen.findAllByTestId('invoice-line')).toHaveLength(2);
    expect(screen.queryByTestId('queue-approve')).toBeNull();
    expect(screen.queryByTestId('queue-reject')).toBeNull();
  });

  it('shows a pending invoice read-only to someone who may only look at stock', async () => {
    signedIn(['inventory.stock.read']);
    mockState.search = `open=${id(9)}`;
    api();
    render(<InvoiceQueuePage />);
    const lines = await screen.findAllByTestId('invoice-line');
    expect(within(lines[0]!).getByTestId<HTMLInputElement>('invoice-line-quantity').disabled).toBe(
      true,
    );
    expect(screen.queryByTestId('queue-approve')).toBeNull();
  });

  it('shows each status on its own tab', async () => {
    signedIn();
    api(invoice('approved'));
    render(<InvoiceQueuePage />);
    expect(await screen.findByText('Nothing waits for approval.')).toBeTruthy();
    await userEvent.click(screen.getByTestId('queue-tab-approved'));
    expect((await screen.findByTestId('queue-status')).textContent).toBe('Approved');
  });
});
