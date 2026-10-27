'use client';

import { useEffect, useState } from 'react';

/**
 * The current time, refreshed every `intervalMs` (and `onTick` called then) while the page is
 * visible: "open 35 min" labels and the floor stay current without a reload.
 */
export function useNow(intervalMs: number, onTick?: () => void): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      setNow(Date.now());
      onTick?.();
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs, onTick]);
  return now;
}
