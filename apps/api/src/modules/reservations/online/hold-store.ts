import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { RedisService } from '../../../platform/redis';
import type { EngineHold } from '../availability/engine';
import { reservationErrors } from '../reservations-errors';

/** What a hold remembers (no personal data): enough for R2.3 to check a booking against it. */
export interface Hold {
  holdId: string;
  page: string;
  locationId: string;
  tableIds: string[];
  start: Date;
  end: Date;
  partySize: number;
  expiresAt: Date;
}

const holdKey = (tenantId: string, holdId: string) => `resv:hold:${tenantId}:${holdId}`;
/** One sorted set per location: member `holdId|tableId|startMs|endMs`, score = the hold's expiry (ms). */
const locationKey = (tenantId: string, locationId: string) =>
  `resv:holds:${tenantId}:${locationId}`;

// KEYS: 1 the new hold, 2 the hold to replace (or the new one again), 3 the location's set.
// ARGV: 1 now, 2 ttl, 3 hold id, 4 start, 5 end, 6 hold json, 7 replaced hold id or '', 8 page, 9.. table ids.
// Drops expired members, refuses (0) when another live hold overlaps one of the tables, frees the replaced hold
// (only one of the same page), adds one member per table and writes the hold: all or nothing.
const ACQUIRE = `
local now, ttl = tonumber(ARGV[1]), tonumber(ARGV[2])
local s, e = tonumber(ARGV[4]), tonumber(ARGV[5])
local old, page = ARGV[7], ARGV[8]
local tables = {}
for i = 9, #ARGV do tables[ARGV[i]] = true end
redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', now)
for _, m in ipairs(redis.call('ZRANGE', KEYS[3], 0, -1)) do
  local id, t, ms, me = string.match(m, '^([^|]+)|([^|]+)|(%d+)|(%d+)$')
  if id ~= old and tables[t] and tonumber(ms) < e and tonumber(me) > s then return 0 end
end
if old ~= '' then
  local raw = redis.call('GET', KEYS[2])
  if raw then
    local h = cjson.decode(raw)
    if h.page == page then
      for _, t in ipairs(h.tableIds) do
        redis.call('ZREM', KEYS[3], old .. '|' .. t .. '|' .. h.startMs .. '|' .. h.endMs)
      end
      redis.call('DEL', KEYS[2])
    end
  end
end
for i = 9, #ARGV do
  redis.call('ZADD', KEYS[3], now + ttl, ARGV[3] .. '|' .. ARGV[i] .. '|' .. ARGV[4] .. '|' .. ARGV[5])
end
if redis.call('PTTL', KEYS[3]) < ttl then redis.call('PEXPIRE', KEYS[3], ttl) end
redis.call('SET', KEYS[1], ARGV[6], 'PX', ttl)
return 1
`;

// KEYS: 1 the hold, 2 the location's set. ARGV: 1 page. Frees a hold of this page; nothing if gone or another's.
const RELEASE = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local h = cjson.decode(raw)
if h.page ~= ARGV[1] then return 0 end
for _, t in ipairs(h.tableIds) do
  redis.call('ZREM', KEYS[2], h.holdId .. '|' .. t .. '|' .. h.startMs .. '|' .. h.endMs)
end
redis.call('DEL', KEYS[1])
return 1
`;

interface Stored {
  holdId: string;
  page: string;
  locationId: string;
  tableIds: string[];
  startMs: number;
  endMs: number;
  partySize: number;
  expiresMs: number;
}

/**
 * Guests' holds on tables while they fill in the booking form (ADR 0019 §4–5, R2.2): in Redis with a TTL, never in
 * Postgres. Advisory: only the online engine treats them as busy; the exclusion constraint still decides at booking.
 * Redis down → `503 reservations.holds_unavailable` (online booking pauses, staff booking is unaffected).
 */
@Injectable()
export class HoldStore {
  constructor(private readonly redis: RedisService) {}

  /** Holds `tableIds` for `[start, end)`; null when another guest holds one of them meanwhile. */
  async acquire(
    tenantId: string,
    hold: {
      page: string;
      locationId: string;
      tableIds: readonly string[];
      start: Date;
      end: Date;
      partySize: number;
    },
    ttlMs: number,
    replaceHoldId?: string,
  ): Promise<Hold | null> {
    const holdId = randomUUID();
    const now = Date.now();
    const stored: Stored = {
      holdId,
      page: hold.page,
      locationId: hold.locationId,
      tableIds: [...hold.tableIds],
      startMs: hold.start.getTime(),
      endMs: hold.end.getTime(),
      partySize: hold.partySize,
      expiresMs: now + ttlMs,
    };
    const replaced = replaceHoldId ?? '';
    const won = await this.run(() =>
      this.redis.eval(
        ACQUIRE,
        3,
        holdKey(tenantId, holdId),
        holdKey(tenantId, replaced || holdId),
        locationKey(tenantId, hold.locationId),
        now,
        ttlMs,
        holdId,
        stored.startMs,
        stored.endMs,
        JSON.stringify(stored),
        replaced,
        hold.page,
        ...hold.tableIds,
      ),
    );
    return won === 1 ? toHold(stored) : null;
  }

  /** Frees a hold of `page`; a missing or foreign one is a no-op. */
  async release(tenantId: string, page: string, locationId: string, holdId: string): Promise<void> {
    await this.run(() =>
      this.redis.eval(
        RELEASE,
        2,
        holdKey(tenantId, holdId),
        locationKey(tenantId, locationId),
        page,
      ),
    );
  }

  /** A live hold of `page`, or null (expired, unknown, another page's). */
  async get(tenantId: string, page: string, holdId: string): Promise<Hold | null> {
    const raw = await this.run(() => this.redis.get(holdKey(tenantId, holdId)));
    if (typeof raw !== 'string') return null;
    const stored = JSON.parse(raw) as Stored;
    return stored.page === page ? toHold(stored) : null;
  }

  /** Every live hold at the location, per table, except `exceptHoldId` (the guest's own, being replaced). */
  async live(tenantId: string, locationId: string, exceptHoldId?: string): Promise<EngineHold[]> {
    const members = await this.run(() =>
      this.redis.zrangebyscore(locationKey(tenantId, locationId), Date.now(), '+inf'),
    );
    return members.flatMap((member) => {
      const [id, tableId, start, end] = member.split('|');
      if (!id || !tableId || id === exceptHoldId) return [];
      return [{ tableId, start: new Date(Number(start)), end: new Date(Number(end)) }];
    });
  }

  private async run<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch {
      throw reservationErrors.holdsUnavailable();
    }
  }
}

const toHold = (s: Stored): Hold => ({
  holdId: s.holdId,
  page: s.page,
  locationId: s.locationId,
  tableIds: s.tableIds,
  start: new Date(s.startMs),
  end: new Date(s.endMs),
  partySize: s.partySize,
  expiresAt: new Date(s.expiresMs),
});
