// @vitest-environment jsdom
import { systemRolePermissions } from '@durby/shared';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockState, resetMocks } from '../../test/mocks';
import { sessionFixture } from '../../test/session-fixture';
import { BrandProvider } from '../theme-provider';
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

const brand = ({ children }: { children: React.ReactNode }) => (
  <BrandProvider
    brand={{
      productName: 'AsiaMight',
      logoUrl: '/brand/asiamight/logo.webp',
      navLayout: 'operations',
    }}
  >
    {children}
  </BrandProvider>
);

describe('a branch request’s documents (ADR 0064)', () => {
  it('confirms the order as soon as it is sent, in the distributor’s layout, no prices', async () => {
    answer(
      request('submitted', {
        lines: [
          line(1, 'Rice'),
          // 12 a box: 24 pieces are 2 boxes.
          line(2, 'Golden Morn', {
            quantity: '24.000',
            packCount: 12 as never,
            packSize: '300.000',
            packUnit: 'g',
          }),
        ],
      }),
    );
    render(<RequestDocument id={id(10)} kind="oc" />, { wrapper: brand });
    const paper = await screen.findByTestId('document-oc');
    expect(within(paper).getByTestId('document-logo').getAttribute('src')).toBe(
      '/brand/asiamight/logo.webp',
    );
    expect(within(paper).getByRole('heading', { name: 'Order Confirmation' })).toBeTruthy();
    expect(within(paper).getByTestId('document-facts').textContent).toContain('13 / 11 / 2026');
    expect(within(paper).getByTestId('document-facts').textContent).toContain('Sam Example');
    expect(within(paper).getByTestId('document-to').textContent).toContain(
      'Address: Carl-Schurz-Str. 1, Berlin',
    );
    // S.No, product, pack size, unit, quantity.
    expect(
      within(paper)
        .getAllByTestId('document-line')
        .map((l) => l.textContent),
    ).toEqual(['1Ricepc6', '2Golden Morn12 × 300 gbox2']);
    expect(within(paper).getByTestId('document-notes').textContent).toContain(
      'Totals: 6 pc and 2 box.',
    );
    expect(paper.textContent).toContain('Confirmed By (Shop)');
    expect(paper.textContent).not.toMatch(/€/);
    expect(screen.getByTestId('document-print')).toBeTruthy();
  });

  it('confirms the delivery once packed: dispatched, brand, best before, driver', async () => {
    answer(request('approved'));
    render(<RequestDocument id={id(10)} kind="dc" />, { wrapper: brand });
    expect(await screen.findByText(/ready once the order is packed/)).toBeTruthy();
    expect(screen.queryByTestId('document-dc')).toBeNull();
    cleanup();

    answer(
      request('packed', {
        driverName: 'Ali',
        lines: [
          line(1, 'Rice', {
            approvedQuantity: '5.000',
            pickedQuantity: '4.000',
            brand: 'Tilda',
            expiresOn: '2028-02-28',
          }),
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
    render(<RequestDocument id={id(10)} kind="dc" />, { wrapper: brand });
    const paper = await screen.findByTestId('document-dc');
    expect(within(paper).getByRole('heading', { name: 'Delivery Confirmation' })).toBeTruthy();
    expect(within(paper).getByTestId('document-facts').textContent).toContain('Ali');
    // Only what was sent: S.No, product, brand, pack, unit, batch/expiry, quantity.
    expect(
      within(paper)
        .getAllByTestId('document-line')
        .map((l) => l.textContent),
    ).toEqual(['1RiceTildapcexp 2028-02-28 × 44']);
    expect(paper.textContent).toContain('Received By (Shop)');
  });
});
