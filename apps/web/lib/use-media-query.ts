import { useSyncExternalStore } from 'react';

/** Whether the screen matches, following changes. True where there is no matchMedia (server, tests). */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const media = globalThis.window?.matchMedia?.(query);
      media?.addEventListener('change', onChange);
      return () => media?.removeEventListener('change', onChange);
    },
    () => globalThis.window?.matchMedia?.(query).matches ?? true,
    () => true,
  );
}
