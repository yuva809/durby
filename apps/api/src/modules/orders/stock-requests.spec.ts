import { describe, expect, it } from 'vitest';
import { canMoveRequest } from './stock-requests.service';

describe('stock request moves (ADR 0045)', () => {
  it('goes submitted → approved → (picking) → packed → in transit → delivered → received', () => {
    expect(canMoveRequest('submitted', 'approved')).toBe(true);
    expect(canMoveRequest('approved', 'picking')).toBe(true);
    expect(canMoveRequest('approved', 'packed')).toBe(true);
    expect(canMoveRequest('picking', 'packed')).toBe(true);
    expect(canMoveRequest('packed', 'in_transit')).toBe(true);
    expect(canMoveRequest('in_transit', 'delivered')).toBe(true);
    expect(canMoveRequest('delivered', 'received')).toBe(true);
  });

  it('lets the branch confirm goods the driver forgot to mark', () => {
    expect(canMoveRequest('packed', 'received')).toBe(true);
    expect(canMoveRequest('in_transit', 'received')).toBe(true);
  });

  it('rejects and cancels only before approval, and ends there', () => {
    expect(canMoveRequest('submitted', 'rejected')).toBe(true);
    expect(canMoveRequest('submitted', 'cancelled')).toBe(true);
    expect(canMoveRequest('approved', 'cancelled')).toBe(false);
    expect(canMoveRequest('approved', 'rejected')).toBe(false);
    for (const end of ['received', 'rejected', 'cancelled'] as const) {
      expect(canMoveRequest(end, 'approved')).toBe(false);
      expect(canMoveRequest(end, 'received')).toBe(false);
    }
    expect(canMoveRequest('submitted', 'packed')).toBe(false);
  });
});
