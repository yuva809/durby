import { describe, expect, it } from 'vitest';
import { canMove, decodeCursor, encodeCursor, lineTotal, orderTotal } from './order-math';

describe('order maths', () => {
  it.each([
    ['2', '1.50', '3.00'],
    ['0.333', '10.00', '3.33'],
    ['0.125', '0.10', '0.01'],
    ['1.005', '1.00', '1.01'],
    ['12.5', '0', '0.00'],
  ])('%s × %s = %s', (quantity, price, total) => {
    expect(lineTotal(quantity, price)).toBe(total);
  });

  it('adds rounded line totals', () => {
    expect(orderTotal([])).toBe('0.00');
    expect(orderTotal(['3.33', '3.33', '3.34'])).toBe('10.00');
  });

  it('allows confirm from draft and cancel until packed', () => {
    expect(canMove('draft', 'confirmed')).toBe(true);
    expect(canMove('confirmed', 'confirmed')).toBe(false);
    expect(canMove('draft', 'cancelled')).toBe(true);
    expect(canMove('packed', 'cancelled')).toBe(true);
    expect(canMove('dispatched', 'cancelled')).toBe(false);
    expect(canMove('cancelled', 'cancelled')).toBe(false);
    expect(canMove('draft', 'delivered')).toBe(false);
    expect(canMove('confirmed', 'picking')).toBe(true);
    expect(canMove('confirmed', 'packed')).toBe(true);
    expect(canMove('picking', 'packed')).toBe(true);
    expect(canMove('packed', 'dispatched')).toBe(true);
    expect(canMove('dispatched', 'delivered')).toBe(true);
    expect(canMove('dispatched', 'returned')).toBe(true);
    expect(canMove('delivered', 'returned')).toBe(false);
    expect(canMove('packed', 'delivered')).toBe(false);
  });
});

describe('order cursor', () => {
  it('round-trips an id and rejects anything else', () => {
    const id = '0190a000-0000-7000-8000-000000000001';
    expect(decodeCursor(encodeCursor(id))).toBe(id);
    expect(decodeCursor('not a cursor!')).toBeNull();
    expect(decodeCursor(encodeCursor('nope'))).toBeNull();
  });
});
