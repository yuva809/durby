import type { RealtimeEventName, RealtimeTopic } from '@durby/shared';

/** Redis channel of one topic at one location of one tenant (ADR 0044 §3). */
export function realtimeChannel(
  tenantId: string,
  locationId: string,
  topic: RealtimeTopic,
): string {
  return `rt:${tenantId}:${locationId}:${topic}`;
}

/** One server-sent event: a name and one JSON data line, ended by a blank line. */
export function sseEvent(name: RealtimeEventName, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** The heartbeat: a comment line, ignored by event-stream parsers. */
export const SSE_PING = ': ping\n\n';

/** Headers of every stream; `no-transform` keeps compressing proxies from buffering it. */
export const SSE_HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};
