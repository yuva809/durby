'use client';

import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  activeSlot,
  type AccountStorage,
  browserAccountStorage,
  forgetAccount,
  freeSlot,
  listAccounts,
  rememberAccount,
  rememberActiveSlot,
  type SignedInAccount,
  slotOfEmail,
} from '../lib/auth/accounts';
import {
  type AuthResult,
  createSessionStore,
  isSessionEnded,
  type Session,
  type SessionStore,
} from '../lib/auth/session';

type Status = 'loading' | 'authenticated' | 'anonymous';

interface AuthValue {
  store: SessionStore;
  session: Session | null;
  status: Status;
}

/** The accounts signed in on this browser and what the person card does with them (ADR 0047). */
export interface Accounts {
  /** Every signed-in account here, this tab's included, by slot. */
  list: SignedInAccount[];
  /** This tab's slot. */
  current: number;
  /** Where "Add another account" signs in: the slot of that email if it's already here, else a free one. */
  slotFor: (email: string) => number | null;
  switchTo: (slot: number) => Promise<AuthResult>;
  /** Signs out this tab's account; returns whether another account took over. */
  signOut: () => Promise<boolean>;
  signOutAll: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);
const AccountsContext = createContext<Accounts | null>(null);

function browserStore(storage: AccountStorage): SessionStore {
  return createSessionStore({
    fetch: (input, init) => fetch(input, init),
    locks: typeof navigator !== 'undefined' ? navigator.locks : undefined,
    slot: activeSlot(storage),
  });
}

/**
 * Opens the first account that still has a live sign-in: this tab's, then the others on this browser. Accounts whose
 * sign-in ended are dropped from the list; an outage stops the search (the accounts may be fine).
 */
async function restore(store: SessionStore, storage: AccountStorage): Promise<void> {
  const first = await store.refresh();
  if (first.ok) return;
  if (!isSessionEnded(first.code)) return;
  forgetAccount(storage, store.slot());
  await openAnother(store, storage);
}

async function openAnother(store: SessionStore, storage: AccountStorage): Promise<boolean> {
  for (const account of listAccounts(storage)) {
    const result = await store.selectAccount(account.slot);
    if (result.ok) return true;
    if (!isSessionEnded(result.code)) return false;
    forgetAccount(storage, account.slot);
  }
  return false;
}

/**
 * One session store per browser tab, on this tab's account slot; restores the session from that slot's refresh cookie
 * on load. Keeps the list of accounts signed in here up to date (docs/platform/auth.md → Several accounts).
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [storage] = useState(browserAccountStorage);
  const [store] = useState(() => browserStore(storage));
  const [restored, setRestored] = useState(false);
  const [list, setList] = useState<SignedInAccount[]>([]);
  const session = useSyncExternalStore(store.subscribe, store.get, () => null);

  useEffect(
    () =>
      store.subscribe((next) => {
        if (next) {
          rememberAccount(storage, { slot: store.slot(), email: next.user.email });
          rememberActiveSlot(storage, store.slot());
        }
        setList(listAccounts(storage));
      }),
    [store, storage],
  );

  useEffect(() => {
    void restore(store, storage).finally(() => {
      setList(listAccounts(storage));
      setRestored(true);
    });
  }, [store, storage]);

  const accounts: Accounts = {
    list,
    current: store.slot(),
    slotFor: (email) => slotOfEmail(storage, email) ?? freeSlot(storage),
    async switchTo(slot) {
      const result = await store.selectAccount(slot);
      if (!result.ok && isSessionEnded(result.code)) {
        forgetAccount(storage, slot);
        setList(listAccounts(storage));
      }
      return result;
    },
    async signOut() {
      const slot = store.slot();
      // Another account first, so the tab never shows the sign-in page in between; then end this one.
      forgetAccount(storage, slot);
      const another = await openAnother(store, storage);
      if (another) await store.logoutSlot(slot);
      else await store.logout().catch(() => undefined);
      setList(listAccounts(storage));
      return another;
    },
    async signOutAll() {
      const current = store.slot();
      for (const account of listAccounts(storage)) {
        if (account.slot !== current) await store.logoutSlot(account.slot);
        forgetAccount(storage, account.slot);
      }
      await store.logout().catch(() => undefined);
      forgetAccount(storage, current);
      setList([]);
    },
  };

  const status: Status = session ? 'authenticated' : restored ? 'anonymous' : 'loading';
  return (
    <AuthContext value={{ store, session, status }}>
      <AccountsContext value={accounts}>{children}</AccountsContext>
    </AuthContext>
  );
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth needs <AuthProvider>');
  return value;
}

export function useAccounts(): Accounts {
  const value = useContext(AccountsContext);
  if (!value) throw new Error('useAccounts needs <AuthProvider>');
  return value;
}
