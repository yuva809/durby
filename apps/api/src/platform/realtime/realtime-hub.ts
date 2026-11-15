import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { PinoLogger } from 'nestjs-pino';
import { APP_CONFIG, type AppConfig } from '../config';

export interface HubListener {
  /** A message on a channel this listener subscribed to (the raw JSON string). */
  message(channel: string, message: string): void;
  /** The subscriber reconnected: messages may have been missed. */
  resync(): void;
}

/**
 * One Redis subscriber per api process (ADR 0044 §4), created with the first stream: SUBSCRIBE on a
 * channel's first listener, UNSUBSCRIBE after its last. ioredis re-subscribes after a reconnect; every
 * listener then gets resync. Never connects in the worker or the CLI (nothing subscribes there).
 */
@Injectable()
export class RealtimeHub implements OnModuleDestroy {
  private subscriber: Redis | undefined;
  private readonly channels = new Map<string, Set<HubListener>>();
  /** True once the subscriber was ready; a later 'ready' is a reconnect. */
  private wasReady = false;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext('realtime');
  }

  /** Subscribes `listener` to `channel`; resolves once Redis confirmed. Returns the unsubscribe. */
  async subscribe(channel: string, listener: HubListener): Promise<() => void> {
    const subscriber = this.connection();
    let listeners = this.channels.get(channel);
    if (!listeners) {
      listeners = new Set();
      this.channels.set(channel, listeners);
    }
    listeners.add(listener);
    try {
      // Also for a channel that's already subscribed: confirms the connection is up now.
      await subscriber.subscribe(channel);
    } catch (error) {
      this.remove(channel, listener);
      throw error;
    }
    return () => this.remove(channel, listener);
  }

  /** Open channels and listeners (the realtime.streams log). */
  stats(): { channels: number; listeners: number } {
    let listeners = 0;
    for (const set of this.channels.values()) listeners += set.size;
    return { channels: this.channels.size, listeners };
  }

  /** Tests: drops the subscriber's connection as a network failure would; resolves when it's back. */
  async reconnectForTest(): Promise<void> {
    const subscriber = this.connection();
    const back = new Promise<void>((resolve) => subscriber.once('ready', () => resolve()));
    subscriber.disconnect(true);
    await back;
  }

  async onModuleDestroy(): Promise<void> {
    const subscriber = this.subscriber;
    this.subscriber = undefined;
    this.channels.clear();
    await subscriber?.quit().catch(() => undefined);
  }

  private remove(channel: string, listener: HubListener): void {
    const listeners = this.channels.get(channel);
    if (!listeners?.delete(listener) || listeners.size > 0) return;
    this.channels.delete(channel);
    void this.subscriber?.unsubscribe(channel).catch(() => undefined);
  }

  private connection(): Redis {
    if (this.subscriber) return this.subscriber;
    const subscriber = new Redis(this.config.REDIS_URL, {
      // Queue commands while reconnecting: subscriptions survive a Redis restart.
      enableOfflineQueue: true,
      maxRetriesPerRequest: null,
      connectTimeout: 5_000,
      retryStrategy: (times) => Math.min(times * 200, 5_000),
    });
    subscriber.on('message', (channel: string, message: string) => {
      for (const listener of this.channels.get(channel) ?? []) listener.message(channel, message);
    });
    subscriber.on('ready', () => {
      if (!this.wasReady) {
        this.wasReady = true;
        return;
      }
      this.logger.info(
        { event: 'realtime.subscriber_reconnected', ...this.stats() },
        'realtime.subscriber_reconnected',
      );
      for (const listeners of this.channels.values()) {
        for (const listener of listeners) listener.resync();
      }
    });
    subscriber.on('error', (error: Error) => {
      this.logger.warn(
        { event: 'realtime.subscriber_error', error: error.message },
        'realtime.subscriber_error',
      );
    });
    this.subscriber = subscriber;
    return subscriber;
  }
}
