'use client';

import { useEffect, useSyncExternalStore } from 'react';
import { tokenFromHash } from './public-requests';

// Read once per page and path: the page then removes the token from the address bar.
const cache = new Map<string, string | null>();

function readToken(parse: (hash: string) => string | null): string | null {
  const path = window.location.pathname;
  if (!cache.has(path)) cache.set(path, parse(window.location.hash));
  return cache.get(path) ?? null;
}

const noSubscription = () => () => undefined;

/**
 * The single-use token of an emailed link (`#token=…`): `undefined` while rendering on the server,
 * then the token or `null` if missing/malformed. Removes it from the URL and history once read.
 * `parse` checks the token's format (reset/verification tokens by default).
 */
export function useLinkToken(
  parse: (hash: string) => string | null = tokenFromHash,
): string | null | undefined {
  const token = useSyncExternalStore(
    noSubscription,
    () => readToken(parse),
    () => undefined,
  );
  useEffect(() => {
    if (window.location.hash) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    }
  }, []);
  return token;
}
