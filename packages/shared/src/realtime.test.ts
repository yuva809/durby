import { describe, expect, it } from 'vitest';
import {
  REALTIME_MAX_IDS,
  REALTIME_STREAMS,
  REALTIME_TOPICS,
  realtimeChangedSchema,
  realtimeDeadAfterMs,
  realtimeReadySchema,
  realtimeResyncSchema,
  realtimeStreamQuerySchema,
} from './realtime';

const uuid = '0192f0b2-6c1a-7c3e-9a6f-1b2c3d4e5f60';

describe('realtime', () => {
  it('serves every topic from exactly one stream, named after the module that owns it', () => {
    const served = Object.entries(REALTIME_STREAMS).flatMap(([stream, topics]) =>
      topics.map((topic) => ({ stream, topic })),
    );
    expect(served.map((s) => s.topic).sort()).toEqual([...REALTIME_TOPICS].sort());
    for (const { stream, topic } of served) expect(topic.split('.')[0]).toBe(stream);
  });

  it('carries ids only, at most REALTIME_MAX_IDS', () => {
    expect(realtimeChangedSchema.parse({ topic: 'reservations', ids: [uuid] })).toEqual({
      topic: 'reservations',
      ids: [uuid],
    });
    const many = Array.from({ length: REALTIME_MAX_IDS + 1 }, () => uuid);
    expect(realtimeChangedSchema.safeParse({ topic: 'reservations', ids: many }).success).toBe(
      false,
    );
    expect(realtimeChangedSchema.safeParse({ topic: 'pos.print', ids: [] }).success).toBe(false);
    expect(
      realtimeChangedSchema.safeParse({ topic: 'reservations', ids: [], name: 'Ada' }).success,
    ).toBe(false);
  });

  it('parses ready, resync and the stream query strictly', () => {
    expect(
      realtimeReadySchema.parse({ heartbeatMs: 15_000, expiresAt: '2026-11-11T10:20:00.000Z' }),
    ).toEqual({ heartbeatMs: 15_000, expiresAt: '2026-11-11T10:20:00.000Z' });
    expect(realtimeResyncSchema.safeParse({ extra: 1 }).success).toBe(false);
    expect(realtimeStreamQuerySchema.safeParse({ locationId: 'x' }).success).toBe(false);
    expect(realtimeStreamQuerySchema.parse({ locationId: uuid })).toEqual({ locationId: uuid });
  });

  it('counts a stream dead after two missed pings and 10 s', () => {
    expect(realtimeDeadAfterMs(15_000)).toBe(40_000);
  });
});
