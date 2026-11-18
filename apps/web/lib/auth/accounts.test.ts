import { describe, expect, it } from 'vitest';
import {
  type AccountStorage,
  activeSlot,
  forgetAccount,
  freeSlot,
  listAccounts,
  rememberAccount,
  rememberActiveSlot,
  slotOfEmail,
} from './accounts';

function memory(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
}

const storage = (): AccountStorage => ({ local: memory(), session: memory() });

describe('signed-in accounts list (ADR 0047)', () => {
  it('remembers emails by slot, one slot per email, and finds free slots', () => {
    const s = storage();
    expect(freeSlot(s)).toBe(0);
    rememberAccount(s, { slot: 0, email: 'anna@example.com' });
    rememberAccount(s, { slot: 2, email: 'ben@example.com' });
    expect(listAccounts(s)).toEqual([
      { slot: 0, email: 'anna@example.com' },
      { slot: 2, email: 'ben@example.com' },
    ]);
    expect(freeSlot(s)).toBe(1);
    expect(slotOfEmail(s, ' BEN@example.com ')).toBe(2);
    // Anna signs in again in another slot: only the new one is kept.
    rememberAccount(s, { slot: 1, email: 'Anna@example.com' });
    expect(listAccounts(s).map((a) => a.slot)).toEqual([1, 2]);
    forgetAccount(s, 2);
    expect(listAccounts(s)).toEqual([{ slot: 1, email: 'Anna@example.com' }]);
  });

  it('is full at five', () => {
    const s = storage();
    for (let slot = 0; slot < 5; slot++) rememberAccount(s, { slot, email: `u${slot}@x.test` });
    expect(freeSlot(s)).toBeNull();
  });

  it("prefers this tab's slot, then the last used, and ignores junk", () => {
    const s = storage();
    expect(activeSlot(s)).toBe(0);
    s.local!.setItem('durby.account', '3');
    expect(activeSlot(s)).toBe(3);
    rememberActiveSlot(s, 1);
    expect(activeSlot(s)).toBe(1);
    s.session!.setItem('durby.account', '9');
    s.local!.setItem('durby.account', 'x');
    expect(activeSlot(s)).toBe(0);
    s.local!.setItem('durby.accounts', '{"not":"a list"}');
    expect(listAccounts(s)).toEqual([]);
  });

  it('works without storage (private mode, blocked site data)', () => {
    const s: AccountStorage = { local: null, session: null };
    rememberAccount(s, { slot: 0, email: 'a@x.test' });
    expect(listAccounts(s)).toEqual([]);
    expect(activeSlot(s)).toBe(0);
    const throwing = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => undefined,
    };
    const t: AccountStorage = { local: throwing, session: throwing };
    rememberAccount(t, { slot: 0, email: 'a@x.test' });
    expect(listAccounts(t)).toEqual([]);
    expect(activeSlot(t)).toBe(0);
  });
});
