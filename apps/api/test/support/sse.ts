/** One item of an event stream: a named event with its JSON data, or a `: comment` line (pings). */
export type SseItem = { event: string; data: unknown } | { comment: string };

export interface SseClient {
  status: number;
  headers: Headers;
  /** The error body when the status isn't 200. */
  body: unknown;
  /** Everything received so far, in order. */
  items: SseItem[];
  /** Resolves with the first item (already received or arriving) that matches, or rejects after `timeoutMs`. */
  next(match: (item: SseItem) => boolean, timeoutMs?: number): Promise<SseItem>;
  /** Named events received so far. */
  events(name: string): unknown[];
  /** Resolves when the server ends the stream. */
  ended: Promise<void>;
  isEnded(): boolean;
  close(): void;
}

export const isEvent =
  (name: string) =>
  (item: SseItem): boolean =>
    'event' in item && item.event === name;
export const isPing = (item: SseItem): boolean => 'comment' in item && item.comment === 'ping';

/** Parses complete blocks (separated by a blank line) out of `buffer`; returns the rest. */
export function parseBlocks(buffer: string, onItem: (item: SseItem) => void): string {
  let rest = buffer;
  let end = rest.indexOf('\n\n');
  while (end !== -1) {
    const block = rest.slice(0, end);
    rest = rest.slice(end + 2);
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) onItem({ comment: line.slice(1).trim() });
      else if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    if (data.length > 0) onItem({ event, data: JSON.parse(data.join('\n')) as unknown });
    end = rest.indexOf('\n\n');
  }
  return rest;
}

/** Opens a stream route with a bearer token over real HTTP (supertest doesn't stream). */
export async function openSse(url: string, token?: string): Promise<SseClient> {
  const controller = new AbortController();
  const res = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal: controller.signal,
  });
  const items: SseItem[] = [];
  const waiters: { match: (item: SseItem) => boolean; resolve: (item: SseItem) => void }[] = [];
  let ended = false;
  let body: unknown = null;

  const push = (item: SseItem) => {
    items.push(item);
    for (const waiter of [...waiters]) {
      if (waiter.match(item)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(item);
      }
    }
  };

  let endedPromise: Promise<void>;
  if (res.status !== 200 || !res.body) {
    body = await res.json().catch(() => null);
    ended = true;
    endedPromise = Promise.resolve();
  } else {
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    endedPromise = (async () => {
      let buffer = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer = parseBlocks((buffer + value).replace(/\r\n/g, '\n'), push);
        }
      } catch {
        // Aborted by close(), or the connection dropped: both end the stream.
      } finally {
        ended = true;
      }
    })();
  }

  return {
    status: res.status,
    headers: res.headers,
    body,
    items,
    events: (name) => items.filter(isEvent(name)).map((i) => (i as { data: unknown }).data),
    next(match, timeoutMs = 3_000) {
      const found = items.find(match);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const waiter = {
          match,
          resolve: (item: SseItem) => {
            clearTimeout(timer);
            resolve(item);
          },
        };
        const timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(waiter), 1);
          reject(new Error(`no matching stream item within ${timeoutMs} ms`));
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
    ended: endedPromise,
    isEnded: () => ended,
    close: () => controller.abort(),
  };
}

/** Resolves true if `promise` settles within `ms`, false otherwise. */
export async function within(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([promise.then(() => true as const), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
