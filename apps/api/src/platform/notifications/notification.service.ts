import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  defaultPreference,
  NOTIFICATION_EVENT_MAX_IDS,
  NOTIFICATION_KINDS,
  NOTIFICATION_LIST_LIMIT,
  type Notification,
  type NotificationEntityType,
  type NotificationKind,
  type NotificationListResponse,
  type NotificationPreference,
  type PushConfigResponse,
  type PushSubscriptionBody,
  type PutNotificationPreferences,
  type RemovePushSubscription,
} from '@durby/shared';
import { ApiError } from '../http';
import { OutboxService } from '../outbox';
import { PUSH_SENDER, type PushSender } from './push-sender';
import {
  TENANT_PRISMA,
  TenantContext,
  type TenantPrismaClient,
  type TenantTransactionClient,
} from '../tenancy';

export interface NewNotification {
  /** Who gets it; repeats are dropped and the actor (the person who caused it) never gets one. */
  userIds: readonly string[];
  kind: NotificationKind;
  entityType: NotificationEntityType;
  entityId: string;
  /** What the text needs (numbers, names); no free text or contact details. */
  params?: Readonly<Record<string, string>>;
}

const SELECT = {
  id: true,
  kind: true,
  entityType: true,
  entityId: true,
  params: true,
  readAt: true,
  createdAt: true,
} as const;

export const notificationErrors = {
  notFound: () =>
    new ApiError(
      HttpStatus.NOT_FOUND,
      'platform.notification_not_found',
      'Notification not found.',
    ),
};

/**
 * Stored notifications (docs/platform/notifications.md, ADR 0047). Modules call `notify` inside the transaction of the
 * change, with the recipients they worked out (MemberNames.holders): a change that rolls back notifies no one. Each
 * person reads and marks only their own.
 */
@Injectable()
export class NotificationService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    private readonly tenantContext: TenantContext,
    private readonly outbox: OutboxService,
    @Inject(PUSH_SENDER) private readonly push: PushSender,
  ) {}

  /**
   * Writes one notification per recipient. `tenantId` defaults to the current tenant (the staff portal passes the
   * organization it acts in, with `app.tenant_id` set in its transaction). Those who chose email or push for the kind
   * get an outbox event (ids only) for the worker to send. Returns the new ids.
   */
  async notify(
    tx: Pick<TenantTransactionClient, 'notification' | 'notificationPreference' | '$queryRaw'>,
    input: NewNotification,
    options: { tenantId?: string; actorUserId?: string | null } = {},
  ): Promise<string[]> {
    const context = this.tenantContext.get();
    const tenantId = options.tenantId ?? context?.tenantId;
    if (!tenantId) throw new Error('notify needs a tenant');
    const actor =
      options.actorUserId === undefined ? (context?.userId ?? null) : options.actorUserId;
    const userIds = [...new Set(input.userIds)].filter((id) => id !== actor);
    if (userIds.length === 0) return [];
    const rows = await tx.notification.createManyAndReturn({
      data: userIds.map((userId) => ({
        tenantId,
        userId,
        kind: input.kind,
        entityType: input.entityType,
        entityId: input.entityId,
        params: { ...(input.params ?? {}) },
      })),
      select: { id: true, userId: true },
    });
    const stored = await tx.notificationPreference.findMany({
      where: { tenantId, kind: input.kind, userId: { in: userIds } },
      select: { userId: true, email: true, push: true },
    });
    const choice = new Map(stored.map((p) => [p.userId, p.email || p.push]));
    const fallback = defaultPreference(input.kind);
    const outgoing = rows
      .filter((r) => choice.get(r.userId) ?? (fallback.email || fallback.push))
      .map((r) => r.id);
    for (let i = 0; i < outgoing.length; i += NOTIFICATION_EVENT_MAX_IDS) {
      await this.outbox.add(
        tx,
        {
          type: 'platform.notification.created',
          payload: { notificationIds: outgoing.slice(i, i + NOTIFICATION_EVENT_MAX_IDS) },
        },
        { tenantId },
      );
    }
    return rows.map((r) => r.id);
  }

  async list(): Promise<NotificationListResponse> {
    const { userId } = this.tenantContext.require();
    const [rows, unread] = await Promise.all([
      this.db.notification.findMany({
        where: { userId },
        select: SELECT,
        orderBy: { id: 'desc' },
        take: NOTIFICATION_LIST_LIMIT,
      }),
      this.db.notification.count({ where: { userId, readAt: null } }),
    ]);
    return { data: rows.map(toResponse), unread };
  }

  async markRead(id: string): Promise<Notification> {
    const { userId } = this.tenantContext.require();
    const row = await this.db.notification.findUnique({ where: { id }, select: { userId: true } });
    if (!row || row.userId !== userId) throw notificationErrors.notFound();
    const updated = await this.db.notification.update({
      where: { id },
      data: { readAt: new Date() },
      select: SELECT,
    });
    return toResponse(updated);
  }

  async markAllRead(): Promise<{ updated: number }> {
    const { userId } = this.tenantContext.require();
    const { count } = await this.db.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });
    return { updated: count };
  }

  /** Every kind with the person's choice, or the default. */
  async preferences(
    userId?: string,
    tx?: TenantTransactionClient,
  ): Promise<NotificationPreference[]> {
    const who = userId ?? this.tenantContext.require().userId;
    const args = {
      where: { userId: who },
      select: { kind: true, email: true, push: true },
    } as const;
    const rows = tx
      ? await tx.notificationPreference.findMany(args)
      : await this.db.notificationPreference.findMany(args);
    const stored = new Map(rows.map((r) => [r.kind, r]));
    return NOTIFICATION_KINDS.map((kind) => {
      const row = stored.get(kind);
      return row ? { kind, email: row.email, push: row.push } : defaultPreference(kind);
    });
  }

  async putPreferences(body: PutNotificationPreferences): Promise<NotificationPreference[]> {
    const { tenantId, userId } = this.tenantContext.require();
    await this.db.$transaction(async (tx) => {
      for (const p of body.preferences) {
        await tx.notificationPreference.upsert({
          where: { tenantId_userId_kind: { tenantId, userId, kind: p.kind } },
          create: { tenantId, userId, kind: p.kind, email: p.email, push: p.push },
          update: { email: p.email, push: p.push },
        });
      }
    });
    return this.preferences(userId);
  }

  pushConfig(): PushConfigResponse {
    return { publicKey: this.push.publicKey };
  }

  /**
   * This browser takes push for the caller in this organization. An endpoint already kept for someone else (a shared
   * device where another person turned push on) moves to the caller: the browser now belongs to this sign-in.
   */
  async subscribe(body: PushSubscriptionBody): Promise<void> {
    const { tenantId, userId } = this.tenantContext.require();
    const data = { userId, p256dh: body.keys.p256dh, auth: body.keys.auth };
    await this.db.pushSubscription.upsert({
      where: { tenantId_endpoint: { tenantId, endpoint: body.endpoint } },
      create: { tenantId, endpoint: body.endpoint, ...data },
      update: data,
    });
  }

  async pushStatus(body: RemovePushSubscription): Promise<{ subscribed: boolean }> {
    const { userId } = this.tenantContext.require();
    const found = await this.db.pushSubscription.findFirst({
      where: { userId, endpoint: body.endpoint },
      select: { id: true },
    });
    return { subscribed: found !== null };
  }

  /** Only the caller's own; an unknown endpoint is fine (already gone). */
  async unsubscribe(body: RemovePushSubscription): Promise<void> {
    const { userId } = this.tenantContext.require();
    await this.db.pushSubscription.deleteMany({ where: { userId, endpoint: body.endpoint } });
  }
}

function toResponse(row: {
  id: string;
  kind: string;
  entityType: string;
  entityId: string;
  params: unknown;
  readAt: Date | null;
  createdAt: Date;
}): Notification {
  return {
    id: row.id,
    kind: row.kind as Notification['kind'],
    entityType: row.entityType as Notification['entityType'],
    entityId: row.entityId,
    params: (row.params ?? {}) as Record<string, string>,
    readAt: row.readAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
