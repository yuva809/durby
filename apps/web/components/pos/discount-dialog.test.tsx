// @vitest-environment jsdom
import type { Order } from '@durby/shared';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockState, resetMocks } from '../../test/mocks';
import { DiscountList } from './discount-dialog';

vi.mock('../../app/providers', async () => (await import('../../test/mocks')).providersMock());
vi.mock('../../app/labels-provider', async () => (await import('../../test/mocks')).labelsMock());
vi.mock('./money', () => ({ useMoney: () => (value: string) => `€${value}` }));

beforeEach(resetMocks);
afterEach(cleanup);

const id = (n: number) => `0190a000-0000-7000-8000-0000000006${String(n).padStart(2, '0')}`;

const ORDER = {
  id: id(1),
  number: 'ORD-2026-000001',
  status: 'open',
  tickets: [
    {
      id: id(2),
      lines: [{ id: id(3), productName: 'Soup', quantity: 2, remaining: 2 }],
    },
  ],
  discounts: [
    {
      id: id(4),
      orderLineId: id(3),
      kind: 'percent',
      value: '10.00',
      reason: 'On the house',
      amount: '-1.38',
      voided: false,
      createdAt: '2026-11-13T12:00:00.000Z',
    },
  ],
} as unknown as Order;

describe('DiscountList', () => {
  it('shows each discount with its item, reason and amount', () => {
    render(<DiscountList order={ORDER} onChanged={() => undefined} />);
    const row = screen.getByTestId('order-discount');
    expect(row.textContent).toContain('Soup');
    expect(row.textContent).toContain('On the house');
    expect(row.textContent).toContain('€-1.38');
  });

  it('removes a discount and reports the change', async () => {
    const onChanged = vi.fn();
    mockState.store.apiFetch.mockResolvedValue(
      Response.json({
        id: id(4),
        orderLineId: id(3),
        kind: 'percent',
        value: '10.00',
        reason: 'On the house',
        amount: '0.00',
        voided: true,
        createdAt: '2026-11-13T12:05:00.000Z',
      }),
    );
    render(<DiscountList order={ORDER} onChanged={onChanged} />);
    await userEvent.click(screen.getByTestId('remove-discount'));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    const [path, init] = mockState.store.apiFetch.mock.calls[0]!;
    expect(path).toBe(`/api/v1/pos/orders/${id(1)}/discounts/${id(4)}/void`);
    expect(init?.method).toBe('POST');
  });
});
