'use client';

import type { RealtimeStream } from '@durby/shared';
import { useEffect, useRef, useState } from 'react';
import type { Api } from '../api-call';
import { openStream, type StreamState, streamPath } from './stream';

/** While live, the page still reloads this often, for changes no event announces. */
export const LIVE_SAFETY_RELOAD_MS = 5 * 60_000;
/** Hints arriving close together cause one reload. */
export const HINT_DEBOUNCE_MS = 250;

export interface LiveRefreshOptions {
  store: Api;
  stream: RealtimeStream;
  /** null: nothing to follow yet (polling only). */
  locationId: string | null;
  /** false: no stream (no permission, feature off); the page polls as before. */
  enabled: boolean;
  /** Reloads what the page shows; may change identity between renders. */
  reload: () => void;
  /** The page's polling interval while the stream isn't live. */
  pollMs: number;
}

/**
 * Keeps a page current (docs/platform/realtime.md → Web, ADR 0044 §8): while the module's stream is
 * live, reloads on its hints (debounced), on `ready` and `resync`, and every 5 min; while it isn't,
 * polls every `pollMs` as before. Only while the tab is visible: a hidden tab closes the stream and
 * reloads once it is visible again.
 */
export function useLiveRefresh(options: LiveRefreshOptions): { live: boolean } {
  const { store, stream, locationId, enabled, pollMs } = options;
  const reloadRef = useRef(options.reload);
  useEffect(() => {
    reloadRef.current = options.reload;
  });
  const [state, setState] = useState<StreamState>('down');
  const [visible, setVisible] = useState(
    () => typeof document === 'undefined' || document.visibilityState === 'visible',
  );

  useEffect(() => {
    const onVisibility = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  const streaming = enabled && locationId !== null && visible;

  // The stream, while enabled and visible.
  useEffect(() => {
    if (!streaming || locationId === null) return;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const soon = () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => reloadRef.current(), HINT_DEBOUNCE_MS);
    };
    const connection = openStream(store, streamPath(stream, locationId), {
      state: setState,
      // Changes may have happened while connecting or reconnecting.
      ready: soon,
      changed: soon,
      resync: soon,
    });
    return () => {
      clearTimeout(debounce);
      connection.close();
    };
  }, [store, stream, locationId, streaming]);

  // A closed stream's last state no longer counts.
  const live = streaming && state === 'live';

  // Polling while not live; the safety reload while live.
  useEffect(() => {
    if (!visible) return;
    const id = setInterval(() => reloadRef.current(), live ? LIVE_SAFETY_RELOAD_MS : pollMs);
    return () => clearInterval(id);
  }, [live, pollMs, visible]);

  // Back from hidden: catch up at once (polling paused, the stream was closed).
  const wasVisible = useRef(visible);
  useEffect(() => {
    if (visible && !wasVisible.current) reloadRef.current();
    wasVisible.current = visible;
  }, [visible]);

  return { live };
}
