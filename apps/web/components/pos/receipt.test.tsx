// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetMocks } from '../../test/mocks';
import { Receipt } from './receipt';

vi.mock('../../app/labels-provider', async () => (await import('../../test/mocks')).labelsMock());
vi.mock('./money', () => ({ useMoney: () => (value: string) => `€${value}` }));

beforeEach(resetMocks);
afterEach(cleanup);

const bill = (footerLines: string[]) => (
  <Receipt
    layout={{
      header: { logo: null, name: 'Bistro', phone: null, email: null, website: null },
      footer: { lines: footerLines },
    }}
    organizationName="Bistro"
    productName="Product"
    tableName="T1"
    order={{ number: 'R-1', covers: 2, waiterName: 'Priya', total: '13.80' }}
    bill={[{ key: 'a', name: 'Soup', quantity: 2, unitPrice: '6.90', total: '13.80', note: null }]}
    printedAt={new Date('2026-11-10T12:00:00Z')}
  />
);

describe('Receipt: interim-bill notice (no TSE yet)', () => {
  it('prints the notice on every bill, whatever the footer setting says', () => {
    for (const lines of [[], ['Danke!', 'Bis bald']]) {
      render(bill(lines));
      expect(screen.getByTestId('bill-interim-notice').textContent).toBe(
        'Interim bill – not a fiscal receipt',
      );
      cleanup();
    }
  });
});
