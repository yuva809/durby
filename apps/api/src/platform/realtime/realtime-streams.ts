import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { RealtimeReady, RealtimeTopic } from '@durby/shared';
import type { Request, Response } from 'express';
import { PinoLogger } from 'nestjs-pino';
import { AuthContext, RevocationService } from '../auth';
import { APP_CONFIG, type AppConfig } from '../config';
import { ApiError, BUSY_RETRY_AFTER_SECONDS } from '../http';
import { TenantContext } from '../tenancy';
import { RealtimeHub } from './realtime-hub';
import { realtimeChannel, SSE_HEADERS, SSE_PING, sseEvent } from './sse';

/** At most this many open streams per session per api process; a new one ends the oldest. */
export const MAX_STREAMS_PER_SESSION = 4;
const STATS_EVERY_MS = 60_000;

/** 503 platform.busy with Retry-After: the client keeps polling and retries the stream later. */
const busy = () =>
  new ApiError(503, 'platform.busy', 'The service is busy. Retry shortly.', undefined, {
    'Retry-After': String(BUSY_RETRY_AFTER_SECONDS),
  });

type CloseReason = 'client' | 'expired' | 'revoked' | 'replaced' | 'shutdown' | 'error';

interface OpenStream {
  sessionId: string;
  end(reason: CloseReason): void;
}

/**
 * Serves a module's stream route (docs/platform/realtime.md, ADR 0044). The route has already run its
 * guards and its own location check (each in a short transaction of its own): an open stream holds
 * no database connection, only a Redis subscription and timers. Ends at the token's expiry, on
 * revocation (checked with every ping), when the session opens one stream too many, and on shutdown.
 */
@Injectable()
export class RealtimeStreams implements OnModuleInit, OnModuleDestroy {
  private readonly active = new Set<OpenStream>();
  private statsTimer: NodeJS.Timeout | undefined;
  /** Shutting down: new streams are refused (503), so clients reconnect to the next api. */
  private closing = false;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly hub: RealtimeHub,
    private readonly auth: AuthContext,
    private readonly tenantContext: TenantContext,
    private readonly revocations: RevocationService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext('realtime');
  }

  onModuleInit(): void {
    this.statsTimer = setInterval(() => {
      if (this.active.size === 0) return;
      this.logger.info(
        { event: 'realtime.streams', streams: this.active.size, ...this.hub.stats() },
        'realtime.streams',
      );
    }, STATS_EVERY_MS);
    this.statsTimer.unref();
  }

  /** Ends every open stream so the http server can close (api shutdown, deploys). */
  onModuleDestroy(): void {
    this.closing = true;
    clearInterval(this.statsTimer);
    for (const stream of [...this.active]) stream.end('shutdown');
  }

  /** Number of open streams (tests, logs). */
  get size(): number {
    return this.active.size;
  }

  /**
   * Opens the stream on `res` for the caller's tenant at `locationId`. Subscribes first: if Redis is
   * down the route answers 503 platform.busy and the client keeps polling.
   */
  async open(
    req: Request,
    res: Response,
    target: { locationId: string; topics: readonly RealtimeTopic[] },
  ): Promise<void> {
    if (this.closing) throw busy();
    const auth = this.auth.require();
    const { tenantId } = this.tenantContext.require();
    const heartbeatMs = this.config.REALTIME_HEARTBEAT_MS;
    let ended = false;
    const unsubscribes: (() => void)[] = [];
    // Set once the stream is open; `end` may run before (client gone while subscribing).
    const timers: { ping?: NodeJS.Timeout; expiry?: NodeJS.Timeout } = {};
    let lastResync = 0;

    const write = (chunk: string) => {
      if (!ended && !res.writableEnded) res.write(chunk);
    };
    const stream: OpenStream = {
      sessionId: auth.sessionId,
      end: (reason) => {
        if (ended) return;
        ended = true;
        clearInterval(timers.ping);
        clearTimeout(timers.expiry);
        for (const unsubscribe of unsubscribes) unsubscribe();
        this.active.delete(stream);
        if (!res.writableEnded) res.end();
        this.logger.debug({ event: 'realtime.stream_closed', reason }, 'realtime.stream_closed');
      },
    };
    const listener = {
      message: (_channel: string, message: string) => write(`event: changed\ndata: ${message}\n\n`),
      resync: () => {
        // One resync per reconnect, though the stream listens on several channels.
        if (Date.now() - lastResync < 1_000) return;
        lastResync = Date.now();
        write(sseEvent('resync', {}));
      },
    };

    try {
      for (const topic of target.topics) {
        unsubscribes.push(
          await this.hub.subscribe(realtimeChannel(tenantId, target.locationId, topic), listener),
        );
      }
    } catch (error) {
      for (const unsubscribe of unsubscribes) unsubscribe();
      this.logger.warn(
        { event: 'realtime.subscribe_failed', error: (error as Error).message },
        'realtime.subscribe_failed',
      );
      throw busy();
    }
    // The client went away, or shutdown began, while we subscribed.
    if (req.destroyed || this.closing) {
      stream.end('client');
      return;
    }

    // One stream too many for this session: end its oldest.
    const ofSession = [...this.active].filter((s) => s.sessionId === auth.sessionId);
    for (const old of ofSession.slice(
      0,
      Math.max(0, ofSession.length - MAX_STREAMS_PER_SESSION + 1),
    )) {
      old.end('replaced');
    }
    this.active.add(stream);
    req.on('close', () => stream.end('client'));
    res.on('error', () => stream.end('error'));

    res.writeHead(200, SSE_HEADERS);
    res.flushHeaders();
    const ready: RealtimeReady = {
      heartbeatMs,
      expiresAt: new Date(auth.expiresAt * 1000).toISOString(),
    };
    write(sseEvent('ready', ready));
    this.logger.debug(
      { event: 'realtime.stream_opened', topics: target.topics },
      'realtime.stream_opened',
    );

    timers.expiry = setTimeout(
      () => stream.end('expired'),
      Math.max(0, auth.expiresAt * 1000 - Date.now()),
    );
    timers.ping = setInterval(() => {
      const claims = {
        userId: auth.userId,
        organizationId: auth.organizationId,
        sessionId: auth.sessionId,
        issuedAt: auth.issuedAt,
        expiresAt: auth.expiresAt,
      };
      this.revocations.isRevoked(claims).then(
        (revoked) => (revoked ? stream.end('revoked') : write(SSE_PING)),
        // The revocation store is down: we can't tell, so end; the client reconnects (and the
        // guard answers 503 until it is back).
        () => stream.end('error'),
      );
    }, heartbeatMs);
  }
}
