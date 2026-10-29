'use client';

import type { StaffMeResponse } from '@durby/shared';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { staffApi } from '../../lib/staff/api';

type StaffSession =
  { status: 'loading' } | { status: 'signedOut' } | { status: 'signedIn'; me: StaffMeResponse };

interface StaffSessionValue {
  session: StaffSession;
  /** Reads /platform/auth/me again (after sign-in or a re-confirmation). */
  reload: () => Promise<void>;
  signOut: () => Promise<void>;
}

const Context = createContext<StaffSessionValue | null>(null);

/**
 * The staff member of the portal (ADR 0017): independent of the customer session. The cookie is
 * HttpOnly, so /platform/auth/me is the only way to know who is signed in.
 */
export function StaffSessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<StaffSession>({ status: 'loading' });

  const reload = useCallback(async () => {
    const result = await staffApi.me();
    setSession(result.ok ? { status: 'signedIn', me: result.data } : { status: 'signedOut' });
  }, []);

  const signOut = useCallback(async () => {
    await staffApi.logout();
    setSession({ status: 'signedOut' });
  }, []);

  useEffect(() => {
    let current = true;
    void staffApi.me().then((result) => {
      if (current) {
        setSession(result.ok ? { status: 'signedIn', me: result.data } : { status: 'signedOut' });
      }
    });
    return () => {
      current = false;
    };
  }, []);

  return <Context value={{ session, reload, signOut }}>{children}</Context>;
}

export function useStaffSession(): StaffSessionValue {
  const value = useContext(Context);
  if (!value) throw new Error('useStaffSession needs <StaffSessionProvider>');
  return value;
}
