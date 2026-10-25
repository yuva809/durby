'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ApiErrorCode } from './auth/errors';

type Loaded<T> = { ok: true; data: T } | { ok: false; code: ApiErrorCode | 'unknown' };

export type Resource<T> =
  | { status: 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'error'; code: ApiErrorCode | 'unknown' };

/**
 * Loads `load()` on mount and whenever `key` changes (e.g. the active organization); `reload()`
 * after a write. A stale answer (key changed meanwhile) is dropped.
 */
export function useResource<T>(
  key: string | null,
  load: () => Promise<Loaded<T>>,
): [Resource<T>, () => void] {
  const [state, setState] = useState<{ key: string | null; value: Resource<T> }>({
    key: null,
    value: { status: 'loading' },
  });
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (key === null) return;
    let current = true;
    void load().then((result) => {
      if (!current) return;
      setState({
        key,
        value: result.ok
          ? { status: 'ready', data: result.data }
          : { status: 'error', code: result.code },
      });
    });
    return () => {
      current = false;
    };
    // `load` is recreated on every render; `key` and `version` decide when to load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, version]);

  const reload = useCallback(() => setVersion((v) => v + 1), []);
  return [state.key === key ? state.value : { status: 'loading' }, reload];
}
