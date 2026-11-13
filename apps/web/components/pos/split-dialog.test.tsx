// @vitest-environment jsdom
import type { Order } from '@durby/shared';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockState, resetMocks } from '../../test/mocks';
import { SplitDialog } from './split-dialog';

vi.mock('../../app/providers', async () => (await import('../../test/mocks')).providersMock());
vi.mock('../../app/labels-provider', async () => (await import('../../test/mocks')).labelsMock());

beforeEach(resetMocks);
afterEach(cleanup);

const id = (n: number) => `0190a000-0000-7000-8000-0000000007${String(n).padStart(2, '0')}`;

const ORDER = {
  id: id(1),
  number: 'ORD-2026-000001',
  status: 'open',
  unbilled: '6.90',
  tickets: [
    {
      id: id(2),
      lines: [
        {
          id: id(3),
          productName: 'Soup',
          quantity: 2,
          remaining: 2,
          billedQuantity: 1,
        },
      ],
    },
  ],
} as unknown as Order;

describe('SplitDialog', () => {
  it('splits the bill equally and reports the first check to print', async () => {
    const onBilled = vi.fn();
    mockState.store.apiFetch.mockResolvedValue(
      Response.json(
        {
          id: id(4),
          kind: 'equal',
          shareCount: 3,
          createdAt: '2026-11-13T12:00:00.000Z',
          cancelled: false,
          checks: [
            { id: id(5), number: 'CHK-2026-000002', shareIndex: 1, gross: '2.30' },
            { id: id(6), number: 'CHK-2026-000003', shareIndex: 2, gross: '2.30' },
            { id: id(7), number: 'CHK-2026-000004', shareIndex: 3, gross: '2.30' },
          ],
          locationId: id(8),
          orderIds: [id(1)],
          gross: '6.90',
        },
        { status: 201 },
      ),
    );
    render(<SplitDialog order={ORDER} locationId={id(8)} onBilled={onBilled} />);
    await userEvent.click(screen.getByTestId('split-bill'));
    await userEvent.selectOptions(screen.getByTestId('split-mode'), 'equal');
    await userEvent.clear(screen.getByTestId('split-guests'));
    await userEvent.type(screen.getByTestId('split-guests'), '3');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onBilled).toHaveBeenCalledWith(id(5)));
    const [path, init] = mockState.store.apiFetch.mock.calls[0]!;
    expect(path).toBe('/api/v1/pos/bills');
    expect(JSON.parse(init?.body as string)).toEqual({ orderIds: [id(1)], shares: 3 });
  });
});
