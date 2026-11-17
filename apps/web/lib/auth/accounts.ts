import { MAX_SIGNED_IN_ACCOUNTS } from '@durby/shared';

/**
 * The accounts signed in on this browser (docs/platform/auth.md → Several accounts, ADR 0047). Each lives in a slot
 * (0 … 4) with its own httpOnly refresh cookie on the api; this list only remembers which email is in which slot, so
 * the person card can offer them. Emails only: nothing secret, no names or organizations. Per site (the browser keeps it per
 * origin), and it survives a reload. Each tab has its own active slot, so two tabs can show two accounts.
 */

export interface SignedInAccount {
  slot: number;
  email: string;
}

const LIST_KEY = 'durby.accounts';
const ACTIVE_KEY = 'durby.account';

/** Browser storage that may be missing or throw (private mode, blocked site data). */
export interface AccountStorage {
  local: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
  session: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
}

export function browserAccountStorage(): AccountStorage {
  const safe = (get: () => Storage) => {
    try {
      return get();
    } catch {
      return null;
    }
  };
  return {
    local: typeof window === 'undefined' ? null : safe(() => window.localStorage),
    session: typeof window === 'undefined' ? null : safe(() => window.sessionStorage),
  };
}

const isSlot = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value >= 0 &&
  value < MAX_SIGNED_IN_ACCOUNTS;

function read(storage: AccountStorage['local'], key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(storage: AccountStorage['local'], key: string, value: string | null): void {
  try {
    if (value === null) storage?.removeItem(key);
    else storage?.setItem(key, value);
  } catch {
    // Storage full or blocked: the list is a convenience; signing in still works.
  }
}

export function listAccounts(storage: AccountStorage): SignedInAccount[] {
  try {
    const parsed: unknown = JSON.parse(read(storage.local, LIST_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<number>();
    return parsed
      .filter(
        (a): a is SignedInAccount =>
          typeof a === 'object' &&
          a !== null &&
          isSlot((a as SignedInAccount).slot) &&
          typeof (a as SignedInAccount).email === 'string',
      )
      .filter((a) => !seen.has(a.slot) && seen.add(a.slot))
      .map((a) => ({ slot: a.slot, email: a.email }));
  } catch {
    return [];
  }
}

function save(storage: AccountStorage, accounts: SignedInAccount[]): void {
  write(storage.local, LIST_KEY, accounts.length > 0 ? JSON.stringify(accounts) : null);
}

/** Records who is in `slot` (replacing whoever was); the same email in another slot is dropped from there. */
export function rememberAccount(storage: AccountStorage, account: SignedInAccount): void {
  const email = account.email.toLowerCase();
  const others = listAccounts(storage).filter(
    (a) => a.slot !== account.slot && a.email.toLowerCase() !== email,
  );
  save(
    storage,
    [...others, { slot: account.slot, email: account.email }].sort((a, b) => a.slot - b.slot),
  );
}

export function forgetAccount(storage: AccountStorage, slot: number): void {
  save(
    storage,
    listAccounts(storage).filter((a) => a.slot !== slot),
  );
}

/** The slot of an email already signed in here, if any. */
export function slotOfEmail(storage: AccountStorage, email: string): number | null {
  const wanted = email.trim().toLowerCase();
  return listAccounts(storage).find((a) => a.email.toLowerCase() === wanted)?.slot ?? null;
}

/** The lowest slot no account uses; null when all five are taken. */
export function freeSlot(storage: AccountStorage): number | null {
  const used = new Set(listAccounts(storage).map((a) => a.slot));
  for (let slot = 0; slot < MAX_SIGNED_IN_ACCOUNTS; slot++) if (!used.has(slot)) return slot;
  return null;
}

/** This tab's account, else the one last used on this browser, else 0. */
export function activeSlot(storage: AccountStorage): number {
  for (const value of [read(storage.session, ACTIVE_KEY), read(storage.local, ACTIVE_KEY)]) {
    const slot = value === null ? NaN : Number(value);
    if (isSlot(slot)) return slot;
  }
  return 0;
}

export function rememberActiveSlot(storage: AccountStorage, slot: number): void {
  write(storage.session, ACTIVE_KEY, String(slot));
  write(storage.local, ACTIVE_KEY, String(slot));
}
