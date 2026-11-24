import { Inject, Injectable } from '@nestjs/common';
import { sendNotification, WebPushError } from 'web-push';
import { APP_CONFIG, type AppConfig } from '../config';

/** Injection token for the {@link PushSender}. */
export const PUSH_SENDER = Symbol('PUSH_SENDER');

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** What the service worker shows: the text and where a tap leads. Nothing else leaves the server. */
export interface PushMessage {
  title: string;
  body?: string;
  url: string;
}

/** `gone`: the push service no longer knows the subscription (404/410); delete it. */
export type PushOutcome = 'sent' | 'gone';

export interface PushSender {
  /** The VAPID public key for browsers to subscribe with; null when push is off on this server. */
  readonly publicKey: string | null;
  send(target: PushTarget, message: PushMessage): Promise<PushOutcome>;
}

/** How long a push message waits at the push service for an offline device. */
const TTL_SECONDS = 24 * 60 * 60;

/** Sends run inside the handler's transaction (5 s): a slow push service must not roll it back (ADR 0083). */
const TIMEOUT_MS = 3_000;

/**
 * Web Push with VAPID (RFC 8030 / 8292) through the `web-push` library: the payload is encrypted for the browser, so
 * the push service (Google, Mozilla, Apple) only sees ciphertext. Never logs endpoints or payloads.
 */
@Injectable()
export class WebPushSender implements PushSender {
  readonly publicKey: string | null;
  private readonly vapid: { subject: string; publicKey: string; privateKey: string } | null;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    const { WEB_PUSH_PUBLIC_KEY, WEB_PUSH_PRIVATE_KEY, WEB_PUSH_SUBJECT } = config;
    this.vapid =
      WEB_PUSH_PUBLIC_KEY && WEB_PUSH_PRIVATE_KEY && WEB_PUSH_SUBJECT
        ? {
            subject: WEB_PUSH_SUBJECT,
            publicKey: WEB_PUSH_PUBLIC_KEY,
            privateKey: WEB_PUSH_PRIVATE_KEY,
          }
        : null;
    this.publicKey = this.vapid?.publicKey ?? null;
  }

  async send(target: PushTarget, message: PushMessage): Promise<PushOutcome> {
    if (!this.vapid) return 'sent';
    try {
      await sendNotification(
        { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
        JSON.stringify(message),
        { vapidDetails: this.vapid, TTL: TTL_SECONDS, timeout: TIMEOUT_MS },
      );
      return 'sent';
    } catch (error) {
      if (error instanceof WebPushError && (error.statusCode === 404 || error.statusCode === 410)) {
        return 'gone';
      }
      // The message has the status only; callers log the message, never the cause (it holds the endpoint).
      throw new Error(
        `push failed${error instanceof WebPushError ? ` with status ${error.statusCode}` : ''}`,
        { cause: error },
      );
    }
  }
}
