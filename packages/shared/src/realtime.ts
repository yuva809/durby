import { z } from 'zod';

/**
 * Live updates (docs/platform/realtime.md, ADR 0044): what a stream route sends. Hints only: ids of
 * changed rows, never data; pages reload through their normal routes.
 */

/** Topics, each owned by one module and served by that module's stream route. */
export const REALTIME_TOPICS = ['reservations', 'pos.floor'] as const;
export type RealtimeTopic = (typeof REALTIME_TOPICS)[number];

/** Stream routes (`GET /<module>/stream`) and the topics each one serves. */
export const REALTIME_STREAMS = {
  reservations: ['reservations'],
  pos: ['pos.floor'],
} as const satisfies Record<string, readonly RealtimeTopic[]>;
export type RealtimeStream = keyof typeof REALTIME_STREAMS;

/** Default ping interval; the api sends its actual value in `ready`. */
export const REALTIME_HEARTBEAT_MS = 15_000;
/** At most this many ids per `changed` message; more are sent as several messages. */
export const REALTIME_MAX_IDS = 50;

/** How long a client waits for any line before it treats the stream as dead: two pings and 10 s. */
export function realtimeDeadAfterMs(heartbeatMs: number): number {
  return heartbeatMs * 2 + 10_000;
}

export const realtimeStreamQuerySchema = z.strictObject({ locationId: z.uuid() });
export type RealtimeStreamQuery = z.infer<typeof realtimeStreamQuerySchema>;

/** First message of every stream, once it is subscribed. */
export const realtimeReadySchema = z.strictObject({
  heartbeatMs: z.int().positive(),
  /** The access token's expiry: the stream ends then and the client reconnects. */
  expiresAt: z.iso.datetime(),
});
export type RealtimeReady = z.infer<typeof realtimeReadySchema>;

/** Something on this topic changed at the stream's location. */
export const realtimeChangedSchema = z.strictObject({
  topic: z.enum(REALTIME_TOPICS),
  ids: z.array(z.uuid()).max(REALTIME_MAX_IDS),
});
export type RealtimeChanged = z.infer<typeof realtimeChangedSchema>;

/** The server may have missed messages (its Redis subscriber reconnected): reload. */
export const realtimeResyncSchema = z.strictObject({});

export const REALTIME_EVENTS = ['ready', 'changed', 'resync'] as const;
export type RealtimeEventName = (typeof REALTIME_EVENTS)[number];
