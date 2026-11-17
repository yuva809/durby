import type { Order, OrderLine } from '@durby/shared';
import { describe, expect, it } from 'vitest';
import {
  billLines,
  checkLines,
  durationLabel,
  fromCents,
  latestChecks,
  minutesSince,
  moneyFormat,
  pickedBillItems,
  pickedBillTotal,
  rate,
  sum,
  times,
  toCents,
} from './format';

describe('decimal strings', () => {
  it('converts to and from cents exactly', () => {
    expect(toCents('12.50')).toBe(1250n);
    expect(toCents('-3.80')).toBe(-380n);
    expect(toCents('7')).toBe(700n);
    expect(fromCents(1250n)).toBe('12.50');
    expect(fromCents(-5n)).toBe('-0.05');
  });

  it('multiplies and sums without floating point', () => {
    expect(times('6.90', 3)).toBe('20.70');
    expect(sum(Array.from({ length: 10 }, () => '0.10'))).toBe('1.00');
    expect(sum([])).toBe('0.00');
  });

  it('trims VAT rates', () => {
    expect(rate('7.00')).toBe('7');
    expect(rate('19.00')).toBe('19');
    expect(rate('5.50')).toBe('5.5');
  });

  it('counts whole minutes', () => {
    const now = Date.parse('2026-10-27T12:35:30Z');
    expect(minutesSince('2026-10-27T12:00:00Z', now)).toBe(35);
    expect(minutesSince('2026-10-27T13:00:00Z', now)).toBe(0);
  });
});

describe('durationLabel', () => {
  it('uses minutes below an hour, hours and minutes above', () => {
    expect(durationLabel(35)).toEqual({ key: 'pos.time.minutes', values: { minutes: '35' } });
    expect(durationLabel(1091)).toEqual({
      key: 'pos.time.hoursMinutes',
      values: { hours: '18', minutes: '11' },
    });
  });
});

describe('moneyFormat', () => {
  it("uses the organization's currency and locale", () => {
    expect(moneyFormat('de', 'EUR')('1234.50')).toBe('1.234,50 €'); // Intl: no-break space
    expect(moneyFormat('en', 'USD')('1234.50')).toBe('$1,234.50');
  });

  it('falls back to the plain string for an unusable currency', () => {
    expect(moneyFormat('en', 'not a currency')('12.50')).toBe('12.50');
  });
});

describe('billLines', () => {
  const line = (n: number, overrides: Partial<OrderLine>): OrderLine => ({
    id: `0190a000-0000-7000-8000-0000000004${String(n).padStart(2, '0')}`,
    ticketId: '0190a000-0000-7000-8000-000000000400',
    productId: '0190a000-0000-7000-8000-000000000499',
    productName: 'Soup',
    unitPrice: '6.90',
    taxRate: '7.00',
    quantity: 1,
    note: null,
    voidsLineId: null,
    remaining: 1,
    billedQuantity: 0,
    total: '6.90',
    createdAt: '2026-10-27T12:00:00.000Z',
    ...overrides,
  });
  const order = (...tickets: OrderLine[][]): Pick<Order, 'tickets'> => ({
    tickets: tickets.map((lines, i) => ({
      id: `0190a000-0000-7000-8000-00000000050${i}`,
      sequence: i + 1,
      kind: 'order' as const,
      station: 'kitchen' as const,
      status: 'new' as const,
      direct: false,
      createdAt: '2026-10-27T12:00:00.000Z',
      lines,
    })),
  });

  it('combines the same product, price and note across tickets', () => {
    const bill = billLines(
      order(
        [
          line(1, { quantity: 2, remaining: 2 }),
          line(2, { productId: 'cola', productName: 'Cola' }),
        ],
        [line(3, {}), line(4, { note: 'no onions' })],
      ),
    );
    expect(bill.map((l) => [l.name, l.note, l.quantity, l.total])).toEqual([
      ['Soup', null, 3, '20.70'],
      ['Cola', null, 1, '6.90'],
      ['Soup', 'no onions', 1, '6.90'],
    ]);
  });

  it('counts what is left after voids and drops fully voided items and void lines', () => {
    const bill = billLines(
      order(
        [line(1, { quantity: 2, remaining: 1 }), line(2, { remaining: 0 })],
        [line(3, { quantity: -1, remaining: 0, voidsLineId: 'x' })],
      ),
    );
    expect(bill.map((l) => [l.quantity, l.total])).toEqual([[1, '6.90']]);
  });

  it('keeps different prices of the same product apart', () => {
    const bill = billLines(order([line(1, {})], [line(2, { unitPrice: '7.40' })]));
    expect(bill.map((l) => l.unitPrice)).toEqual(['6.90', '7.40']);
  });

  describe('picking items to bill (Step 4c)', () => {
    // 3 Soup over two tickets (2 + 1), one of them already billed; 1 Cola.
    const picked = order(
      [
        line(1, { quantity: 2, remaining: 2, billedQuantity: 1 }),
        line(2, { productId: 'cola', productName: 'Cola', unitPrice: '3.80' }),
      ],
      [line(3, {})],
    );

    it('knows what of each line is unbilled and which sent lines it comes from', () => {
      const [soup, cola] = billLines(picked);
      expect([soup!.quantity, soup!.unbilled, soup!.parts]).toEqual([
        3,
        2,
        [
          { orderLineId: line(1, {}).id, unbilled: 1 },
          { orderLineId: line(3, {}).id, unbilled: 1 },
        ],
      ]);
      expect(cola!.unbilled).toBe(1);
    });

    it('takes the picked count from the oldest sent lines first, capped at what is unbilled', () => {
      const bill = billLines(picked);
      const [soup, cola] = bill;
      expect(pickedBillItems(bill, { [soup!.key]: 2, [cola!.key]: 1 })).toEqual([
        { orderLineId: line(1, {}).id, quantity: 1 },
        { orderLineId: line(3, {}).id, quantity: 1 },
        { orderLineId: line(2, {}).id, quantity: 1 },
      ]);
      expect(pickedBillItems(bill, { [soup!.key]: 1 })).toEqual([
        { orderLineId: line(1, {}).id, quantity: 1 },
      ]);
      // The order changed meanwhile: never more than is left.
      expect(pickedBillItems(bill, { [soup!.key]: 9 })).toHaveLength(2);
      expect(pickedBillItems(bill, {})).toEqual([]);
    });

    it('adds up what is picked', () => {
      const bill = billLines(picked);
      expect(pickedBillTotal(bill, { [bill[0]!.key]: 2, [bill[1]!.key]: 1 })).toEqual({
        items: 3,
        gross: '17.60',
      });
      expect(pickedBillTotal(bill, {})).toEqual({ items: 0, gross: '0.00' });
    });
  });
});

describe('checkLines and latestChecks (docs/modules/pos.md → Step 4)', () => {
  const item = (name: string, quantity: number, unitPrice = '6.90') => ({
    kind: 'item' as const,
    name,
    quantity,
    unitPrice,
    taxRate: '7.00',
    total: times(unitPrice, quantity),
  });

  it('combines the items of a check by name and price, in billing order', () => {
    const lines = checkLines({
      lines: [item('Soup', 1), item('Cola', 1, '3.80'), item('Soup', 2), item('Soup', 1, '7.40')],
    });
    expect(lines.map((l) => [l.name, l.quantity, l.total])).toEqual([
      ['Soup', 3, '20.70'],
      ['Cola', 1, '3.80'],
      ['Soup', 1, '7.40'],
    ]);
  });

  it('keeps other lines (discounts, shares) as they are', () => {
    const lines = checkLines({
      lines: [
        item('Soup', 1),
        {
          kind: 'discount',
          name: 'Complaint',
          quantity: null,
          unitPrice: null,
          taxRate: '7.00',
          total: '-1.00',
        },
      ],
    });
    expect(lines.map((l) => [l.name, l.total])).toEqual([
      ['Soup', '6.90'],
      ['Complaint', '-1.00'],
    ]);
  });

  it("reprints the newest bill that isn't cancelled", () => {
    const bill = (id: string, cancelled: boolean) => ({
      id,
      kind: 'single' as const,
      shareCount: null,
      createdAt: '2026-11-12T12:00:00.000Z',
      cancelled,
      checks: [{ id: `${id}-check`, number: id, shareIndex: null, gross: '1.00' }],
    });
    expect(latestChecks({ bills: [] })).toEqual([]);
    expect(
      latestChecks({ bills: [bill('a', false), bill('b', false), bill('c', true)] }).map(
        (c) => c.id,
      ),
    ).toEqual(['b-check']);
  });
});
