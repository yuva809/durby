'use client';

import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
} from 'react';
import { createSessionStore, type Session, type SessionStore } from '../lib/auth/session';

type Status = 'loading' | 'authenticated' | 'anonymous';

interface AuthValue {
  store: SessionStore;
  session: Session | null;
  status: Status;
}

const AuthContext = createContext<AuthValue | null>(null);

function browserStore(): SessionStore {
  return createSessionStore({
    fetch: (input, init) => fetch(input, init),
    locks: typeof navigator !== 'undefined' ? navigator.locks : undefined,
  });
}

/** One session store per browser tab; restores the session from the refresh cookie on load. */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [store] = useState(browserStore);
  const [restored, setRestored] = useState(false);
  const session = useSyncExternalStore(store.subscribe, store.get, () => null);

  useEffect(() => {
    void store.refresh().finally(() => setRestored(true));
  }, [store]);

  const status: Status = session ? 'authenticated' : restored ? 'anonymous' : 'loading';
  return <AuthContext value={{ store, session, status }}>{children}</AuthContext>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth needs <AuthProvider>');
  return value;
}
