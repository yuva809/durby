// @vitest-environment jsdom
import { systemRolePermissions } from '@durby/shared';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockState, resetMocks } from '../../test/mocks';
import { sessionFixture } from '../../test/session-fixture';
import { RequestDocument } from './request-document';

vi.mock('../../app/providers', async () => (await import('../../test/mocks')).providersMock());
vi.mock('../../app/labels-provider', async () => (await import('../../test/mocks')).labelsMock());
vi.mock('next/navigation', async () => (await import('../../test/mocks')).navigationMock());

beforeEach(resetMocks);
afterEach(cleanup);

const id = (n: number) => `0190a000-0000-7000-8000-0000000064${String(n).padStart(2, '0')}`;
const line = (n: number, name: string, extra: Record<string, string | null> = {}) => ({
  id: id(40 + n),
  itemId: id(50 + n),
  itemName: name,
  unit: 'pc',
  quantity: '6.000',
  approvedQuantity: null,
  pickedQuantity: null,
  receivedQuantity: null,
  ...extra,
});
const request = (status: string, extra: Record<string, unknown> = {}) => ({
  id: id(10),
  number: 'SRQ-2026-000047',
  transferNumber: status === 'submitted' ? null : 'TRF-2026-000047',
  status,
  fromWarehouseId: id(1),
  fromWarehouseName: 'Main Warehouse',
  fromLocationName: 'Head office',
  toWarehouseId: id(3),
  toWarehouseName: 'Store',
  locationId: id(4),
  locationName: 'Spandau',
  lineCount: 2,
  driverUserId: null,
  driverName: null,
  requestedByName: 'Sam Example',
  createdAt: '2026-11-13T09:00:00.000Z',
  updatedAt: '2026-11-14T09:00:00.000Z',
  note: 'For the weekend',
  locationAddress: 'Carl-Schurz-Str. 1, Berlin',
  fromLocationAddress: null,
  lines: [line(1, 'Rice'), line(2, 'Oil')],
  events: [
    {
      id: id(30),
      status: 'submitted',
      note: null,
      userId: null,
      createdAt: '2026-11-13T09:00:00.000Z',
    },
  ],
  ...extra,
});

function answer(detail: ReturnType<typeof request>) {
  mockState.session = sessionFixture({
    activePermissions: [...systemRolePermissions('branch')],
    activeFeatures: ['inventory', 'orders'],
  });
  mockState.store.apiFetch.mockImplementation(() => Promise.resolve(Response.json(detail)));
}

describe('a branch request’s documents (ADR 0064)', () => {
  it('confirms the order as soon as it is sent: what was asked, for whom, no prices', async () => {
    answer(request('submitted'));
    render(<RequestDocument id={id(10)} kind="oc" />);
    const paper = await screen.findByTestId('document-oc');
    expect(within(paper).getByRole('heading', { name: 'Order Confirmation' })).toBeTruthy();
    expect(within(paper).getByTestId('document-number').textContent).toBe('SRQ-2026-000047');
    expect(within(paper).getByTestId('document-to').textContent).toContain(
      'Carl-Schurz-Str. 1, Berlin',
    );
    expect(paper.textContent).toContain('Sam Example');
    expect(paper.textContent).toContain('For the weekend');
    const lines = within(paper).getAllByTestId('document-line');
    // #, item, unit, requested, approved (not yet).
    expect(lines.map((l) => l.textContent)).toEqual(['1Ricepc6–', '2Oilpc6–']);
    expect(paper.textContent).not.toMatch(/€/);
    expect(screen.getByTestId('document-print')).toBeTruthy();
  });

  it('has a delivery challan once packed: what was sent, its driver, room to sign', async () => {
    answer(request('approved'));
    render(<RequestDocument id={id(10)} kind="dc" />);
    expect(await screen.findByText(/ready once the order is packed/)).toBeTruthy();
    expect(screen.queryByTestId('document-dc')).toBeNull();
    cleanup();

    answer(
      request('packed', {
        driverName: 'Ali',
        lines: [
          line(1, 'Rice', { approvedQuantity: '5.000', pickedQuantity: '4.000' }),
          line(2, 'Oil', { approvedQuantity: '1.000', pickedQuantity: '0.000' }),
        ],
        events: [
          {
            id: id(31),
            status: 'packed',
            note: null,
            userId: null,
            createdAt: '2026-11-14T10:00:00.000Z',
          },
        ],
      }),
    );
    render(<RequestDocument id={id(10)} kind="dc" />);
    const paper = await screen.findByTestId('document-dc');
    expect(within(paper).getByRole('heading', { name: 'Delivery Challan' })).toBeTruthy();
    expect(within(paper).getByTestId('document-number').textContent).toBe('TRF-2026-000047');
    expect(paper.textContent).toContain('Ali');
    // Only what was sent; the received column is left to write in.
    expect(
      within(paper)
        .getAllByTestId('document-line')
        .map((l) => l.textContent),
    ).toEqual(['1Ricepc4']);
    expect(paper.textContent).toContain('Received by (name, signature, date)');
  });
});
