import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  type ClaimPrintJobResponse,
  type DuePrintJobsResponse,
  PRINT_JOB_ANSWER_TIMEOUT_MS,
  PRINT_JOB_WAIT_WARNING_MS,
  type PrepStation,
  type PrintJob,
  type PrintJobResultRequest,
  type PrintJobStatusResponse,
  printJobOutcome,
  printJobRetryDelayMs,
  type QueueBillPrintJobRequest,
} from '@durby/shared';
import { auditActor, AuditService, snapshot } from '../../platform/audit';
import { IdempotencyService } from '../../platform/idempotency';
import { SettingsService } from '../../platform/config/settings';
import { AccessService } from '../../platform/rbac';
import { RedisService } from '../../platform/redis';
import {
  TENANT_PRISMA,
  TenantContext,
  type TenantPrismaClient,
  type TenantTransactionClient,
} from '../../platform/tenancy';
import { isUniqueViolation, posErrors } from './pos-errors';

const SELECT = {
  id: true,
  locationId: true,
  printerId: true,
  kind: true,
  orderId: true,
  ticketId: true,
  status: true,
  attempts: true,
  lastCode: true,
  notBefore: true,
  expiresAt: true,
  createdAt: true,
  claimedAt: true,
  completedAt: true,
} as const;

interface Row {
  id: string;
  locationId: string;
  printerId: string;
  kind: PrintJob['kind'];
  orderId: string;
  ticketId: string | null;
  status: PrintJob['status'];
  attempts: number;
  lastCode: string | null;
  notBefore: Date;
  expiresAt: Date;
  createdAt: Date;
  claimedAt: Date | null;
  completedAt: Date | null;
}

/** The same row as a raw `RETURNING` gives it. */
interface RawRow {
  id: string;
  location_id: string;
  printer_id: string;
  kind: PrintJob['kind'];
  order_id: string;
  ticket_id: string | null;
  status: PrintJob['status'];
  attempts: number;
  last_code: string | null;
  not_before: Date;
  expires_at: Date;
  created_at: Date;
  claimed_at: Date | null;
  completed_at: Date | null;
}

const fromRaw = (r: RawRow): Row => ({
  id: r.id,
  locationId: r.location_id,
  printerId: r.printer_id,
  kind: r.kind,
  orderId: r.order_id,
  ticketId: r.ticket_id,
  status: r.status,
  attempts: r.attempts,
  lastCode: r.last_code,
  notBefore: r.not_before,
  expiresAt: r.expires_at,
  createdAt: r.created_at,
  claimedAt: r.claimed_at,
  completedAt: r.completed_at,
});

/** How long the last poll of a location's till counts as "a till is printing" (ADR 0033 §12). */
const TILL_SEEN_TTL_S = 3_600;

/**
 * Print jobs (ADR 0033 §10–12): a sent ticket queues one job per printer that is on and serves its station, in the
 * ticket's own transaction; a device without the app queues a bill. A till with the app at the location polls (one
 * indexed read), claims the oldest due job with one atomic UPDATE (exactly one till wins), prints it and answers.
 * A job is retried by itself only when nothing can have printed; one that may have printed waits for a person.
 * Never deleted, every change audited.
 */
@Injectable()
export class PrintJobsService {
  private readonly logger = new Logger(PrintJobsService.name);

  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    private readonly tenantContext: TenantContext,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly redis: RedisService,
    private readonly settings: SettingsService,
  ) {}

  /** When a job queued now stops printing by itself: `pos.printJobMaxAgeSeconds` at the location. */
  private async expiryAt(
    tx: TenantTransactionClient,
    locationId: string,
    now: Date,
  ): Promise<Date> {
    const resolved = await this.settings.all({ locationId }, tx);
    const seconds = resolved.get('pos.printJobMaxAgeSeconds')?.value;
    return new Date(now.getTime() + (typeof seconds === 'number' ? seconds : 600) * 1000);
  }

  /**
   * Queues a ticket on every printer of the location that is on and prints this station (inside the ticket's own
   * transaction; OrdersService). A station without such a printer prints nothing here.
   */
  async queueTicket(
    tx: TenantTransactionClient,
    ticket: { id: string; orderId: string; locationId: string; station: PrepStation },
  ): Promise<void> {
    const { tenantId, userId } = this.tenantContext.require();
    const printers = await tx.posPrinter.findMany({
      where: {
        locationId: ticket.locationId,
        enabled: true,
        archivedAt: null,
        stations: { some: { stationKey: ticket.station } },
      },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    if (printers.length === 0) return;
    const now = new Date();
    const expiresAt = await this.expiryAt(tx, ticket.locationId, now);
    for (const printer of printers) {
      const row = await tx.posPrintJob.create({
        data: {
          tenantId,
          locationId: ticket.locationId,
          printerId: printer.id,
          kind: 'ticket',
          orderId: ticket.orderId,
          ticketId: ticket.id,
          requestedByUserId: userId,
          expiresAt,
        },
        select: SELECT,
      });
      await this.audit.record(tx, {
        action: 'pos.print_job.queued',
        actor: auditActor.user(userId),
        entityId: row.id,
        after: jobSnapshot(row),
      });
    }
  }

  /** A bill from a device without the app, for a receipt printer of the order's location (`pos.bills.print` there). */
  async queueBill(body: QueueBillPrintJobRequest): Promise<PrintJob> {
    // Two taps at the same moment: the unique index lets one in, and the other runs again and finds that job.
    try {
      return await this.queueBillOnce(body);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      return this.queueBillOnce(body);
    }
  }

  private queueBillOnce(body: QueueBillPrintJobRequest): Promise<PrintJob> {
    const { tenantId, userId } = this.tenantContext.require();
    return this.db.$transaction(async (tx) => {
      const order = await tx.posOrder.findUnique({
        where: { id: body.orderId },
        select: { locationId: true },
      });
      if (!order || !(await this.access.can('pos.bills.print', { locationId: order.locationId }))) {
        throw posErrors.orderNotFound();
      }
      const printer = await tx.posPrinter.findFirst({
        where: {
          id: body.printerId,
          locationId: order.locationId,
          enabled: true,
          printsBills: true,
          archivedAt: null,
        },
        select: { id: true },
      });
      if (!printer) throw posErrors.printerNotFound();
      const now = new Date();
      const expiresAt = await this.expiryAt(tx, order.locationId, now);
      // One open bill per order and printer (pos_print_jobs_open_bill_key): a second tap gets the same job.
      const open = await tx.posPrintJob.findFirst({
        where: {
          orderId: body.orderId,
          printerId: printer.id,
          kind: 'bill',
          status: { in: ['pending', 'claimed'] },
        },
        select: SELECT,
      });
      let job: PrintJob;
      if (open && open.status === 'pending' && open.expiresAt <= now) {
        // Waited too long to print by itself: this tap asks again, with a new window.
        job = await this.requeue(tx, open, now, expiresAt, userId);
      } else if (open) {
        job = toJob(open, now);
      } else {
        const row = await tx.posPrintJob.create({
          data: {
            tenantId,
            locationId: order.locationId,
            printerId: printer.id,
            kind: 'bill',
            orderId: body.orderId,
            requestedByUserId: userId,
            expiresAt,
          },
          select: SELECT,
        });
        await this.audit.record(tx, {
          action: 'pos.print_job.queued',
          actor: auditActor.user(userId),
          entityId: row.id,
          after: jobSnapshot(row),
        });
        job = toJob(row, now);
      }
      await this.idempotency.completeInTransaction(tx, job);
      return job;
    });
  }

  /**
   * The till's poll (every 1.5 s while the app is open): due jobs of the location, one indexed read and no write. It
   * also notes in Redis that a till is printing here, for the warnings; a Redis error never fails the poll.
   */
  async due(locationId: string): Promise<DuePrintJobsResponse> {
    await this.tillAt(locationId);
    // The database's clock, as the claim uses: a job is never due here and unclaimable there. Expired jobs (older
    // than pos.printJobMaxAgeSeconds) are left out: only a reprint brings them back.
    const data = await this.db.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "pos_print_jobs"
       WHERE "location_id" = ${locationId}::uuid AND "status" = 'pending'
         AND "not_before" <= now() AND "expires_at" > now()
       ORDER BY "not_before", "id"
       LIMIT 20`;
    this.markTillSeen(locationId);
    return { data };
  }

  /** One atomic UPDATE takes the oldest due job: of two tills asking at once, exactly one gets it. */
  async claim(locationId: string): Promise<ClaimPrintJobResponse> {
    const { userId } = this.tenantContext.require();
    await this.tillAt(locationId);
    return this.db.$transaction(async (tx) => {
      const [raw] = await tx.$queryRaw<RawRow[]>`
        UPDATE "pos_print_jobs"
           SET "status" = 'claimed', "claimed_at" = now(), "claimed_by_user_id" = ${userId}::uuid,
               "updated_at" = now()
         WHERE "id" = (
                 SELECT "id" FROM "pos_print_jobs"
                  WHERE "location_id" = ${locationId}::uuid AND "status" = 'pending' AND "not_before" <= now()
                    AND "expires_at" > now()
                  ORDER BY "not_before", "id"
                  LIMIT 1
               )
           AND "status" = 'pending' AND "not_before" <= now() AND "expires_at" > now()
        RETURNING "id", "location_id", "printer_id", "kind", "order_id", "ticket_id", "status", "attempts",
                  "last_code", "not_before", "expires_at", "created_at", "claimed_at", "completed_at"`;
      const row = raw ? fromRaw(raw) : null;
      if (row) {
        await this.audit.record(tx, {
          action: 'pos.print_job.claimed',
          actor: auditActor.user(userId),
          entityId: row.id,
          before: jobSnapshot({ ...row, status: 'pending' }),
          after: jobSnapshot(row),
        });
      }
      const response = { job: row ? toJob(row, new Date()) : null };
      await this.idempotency.completeInTransaction(tx, response);
      return response;
    });
  }

  /**
   * The claiming till's answer (ADR 0033 §12): printed; back to the queue after a wait when nothing can have printed;
   * "needs check" when it may have printed; failed when it can't print as it is. Accepted after the answer timeout
   * too: a late "sent" is still the truth.
   */
  async answer(id: string, body: PrintJobResultRequest): Promise<PrintJob> {
    const { userId } = this.tenantContext.require();
    const found = await this.db.posPrintJob.findUnique({
      where: { id },
      select: { locationId: true },
    });
    if (!found || !(await this.access.can('pos.bills.print', { locationId: found.locationId }))) {
      throw posErrors.printJobNotFound();
    }
    const outcome = printJobOutcome(body.code, body.nothingPrinted);
    return this.db.$transaction(async (tx) => {
      const before = await tx.posPrintJob.findUnique({ where: { id }, select: SELECT });
      if (!before) throw posErrors.printJobNotFound();
      if (before.status !== 'claimed') throw posErrors.printJobNotClaimed();
      const attempts = before.attempts + 1;
      const now = new Date();
      const retryAt = new Date(now.getTime() + printJobRetryDelayMs(attempts));
      // A retry that would come after the job's maximum age never prints by itself: a person decides.
      const tooOld = outcome === 'retry' && retryAt >= before.expiresAt;
      const data =
        outcome !== 'retry'
          ? { status: outcome, attempts, lastCode: body.code, completedAt: now }
          : tooOld
            ? { status: 'needs_check' as const, attempts, lastCode: EXPIRED, completedAt: now }
            : {
                status: 'pending' as const,
                attempts,
                lastCode: body.code,
                notBefore: retryAt,
                claimedAt: null,
                claimedByUserId: null,
              };
      // Only the till that holds the job answers it: the claim's owner in the WHERE.
      const updated = await tx.posPrintJob.updateMany({
        where: { id, status: 'claimed', claimedByUserId: userId },
        data,
      });
      if (updated.count === 0) throw posErrors.printJobNotClaimed();
      const after = await tx.posPrintJob.findUniqueOrThrow({ where: { id }, select: SELECT });
      await this.audit.record(tx, {
        action: 'pos.print_job.answered',
        actor: auditActor.user(userId),
        entityId: id,
        before: jobSnapshot(before),
        after: jobSnapshot(after),
      });
      const job = toJob(after, now);
      await this.idempotency.completeInTransaction(tx, job);
      return job;
    });
  }

  /**
   * Back to the queue after a person looked (ADR 0033 §12): a job that may have printed, couldn't print, or was
   * claimed and never answered. `pos.bills.print` at its location.
   */
  async reprint(id: string): Promise<PrintJob> {
    const { userId } = this.tenantContext.require();
    const found = await this.db.posPrintJob.findUnique({
      where: { id },
      select: { locationId: true },
    });
    if (!found || !(await this.access.can('pos.bills.print', { locationId: found.locationId }))) {
      throw posErrors.printJobNotFound();
    }
    return this.db.$transaction(async (tx) => {
      const before = await tx.posPrintJob.findUnique({ where: { id }, select: SELECT });
      if (!before) throw posErrors.printJobNotFound();
      const now = new Date();
      const shown = toJob(before, now);
      if (!shown.stale && !['failed', 'needs_check'].includes(shown.status)) {
        throw posErrors.printJobNotReprintable();
      }
      // A new window of the same length as the job's first one.
      const window = before.expiresAt.getTime() - before.createdAt.getTime();
      const job = await this.requeue(tx, before, now, new Date(now.getTime() + window), userId);
      await this.idempotency.completeInTransaction(tx, job);
      return job;
    });
  }

  /** Back to the queue, due now, with a new expiry; audited as a reprint. */
  private async requeue(
    tx: TenantTransactionClient,
    before: Row,
    now: Date,
    expiresAt: Date,
    userId: string,
  ): Promise<PrintJob> {
    const updated = await tx.posPrintJob.updateMany({
      where: { id: before.id, status: before.status },
      data: {
        status: 'pending',
        // Due at once: a time the database clock has passed (the claim compares with it).
        notBefore: before.createdAt,
        expiresAt,
        claimedAt: null,
        claimedByUserId: null,
        completedAt: null,
      },
    });
    if (updated.count === 0) throw posErrors.printJobNotReprintable();
    const after = await tx.posPrintJob.findUniqueOrThrow({
      where: { id: before.id },
      select: SELECT,
    });
    await this.audit.record(tx, {
      action: 'pos.print_job.reprinted',
      actor: auditActor.user(userId),
      entityId: before.id,
      before: jobSnapshot(before),
      after: jobSnapshot(after),
    });
    return toJob(after, now);
  }

  /** What the warnings show at a location (`pos.orders.read` there). */
  async status(locationId: string): Promise<PrintJobStatusResponse> {
    if (!(await this.access.can('pos.orders.read', { locationId }))) {
      throw posErrors.locationNotFound();
    }
    const now = new Date();
    const waitingSince = new Date(now.getTime() - PRINT_JOB_WAIT_WARNING_MS);
    const staleSince = new Date(now.getTime() - PRINT_JOB_ANSWER_TIMEOUT_MS);
    const [waiting, oldest, retrying, attention] = await this.db.$transaction(async (tx) => {
      const location = await tx.location.findUnique({
        where: { id: locationId },
        select: { id: true },
      });
      if (!location) throw posErrors.locationNotFound();
      const pendingOld = {
        locationId,
        status: 'pending' as const,
        createdAt: { lte: waitingSince },
        expiresAt: { gt: now },
      };
      return Promise.all([
        tx.posPrintJob.count({ where: pendingOld }),
        tx.posPrintJob.findFirst({
          where: pendingOld,
          select: { createdAt: true },
          orderBy: { createdAt: 'asc' },
        }),
        tx.posPrintJob.groupBy({
          by: ['printerId', 'lastCode'],
          where: { locationId, status: 'pending', lastCode: { not: null }, expiresAt: { gt: now } },
          _count: { _all: true },
        }),
        tx.posPrintJob.findMany({
          where: {
            locationId,
            OR: [
              { status: { in: ['failed', 'needs_check'] } },
              { status: 'claimed', claimedAt: { lte: staleSince } },
              // Waited past its maximum age: never printed by itself (shown as needs check).
              { status: 'pending', expiresAt: { lte: now } },
            ],
          },
          select: SELECT,
          orderBy: { createdAt: 'asc' },
          take: 50,
        }),
      ]);
    });
    return {
      tillSeenAt: await this.tillSeenAt(locationId),
      waiting: { count: waiting, oldestAt: oldest?.createdAt.toISOString() ?? null },
      retrying: retrying.map((r) => ({
        printerId: r.printerId,
        lastCode: r.lastCode ?? '',
        count: r._count._all,
      })),
      attention: attention.map((r) => toJob(r, now)),
    };
  }

  /** A till runs jobs at a location where it may print bills; elsewhere the location doesn't exist for it. */
  private async tillAt(locationId: string): Promise<void> {
    if (!(await this.access.can('pos.bills.print', { locationId }))) {
      throw posErrors.locationNotFound();
    }
  }

  private seenKey(locationId: string): string {
    const { tenantId } = this.tenantContext.require();
    return `durby:print:till-seen:${tenantId}:${locationId}`;
  }

  private markTillSeen(locationId: string): void {
    this.redis
      .set(this.seenKey(locationId), new Date().toISOString(), 'EX', TILL_SEEN_TTL_S)
      .catch((error: unknown) => this.logger.warn({ error }, 'till seen not recorded'));
  }

  private async tillSeenAt(locationId: string): Promise<string | null> {
    try {
      return await this.redis.get(this.seenKey(locationId));
    } catch {
      return null;
    }
  }
}

/** The answer code a job too old to print by itself shows (pos.printJobMaxAgeSeconds). */
const EXPIRED = 'print.expired';

/**
 * A job as the api shows it. A pending job past its maximum age is stored as pending (nothing claims it any more)
 * and shown as needs check with `print.expired`, like one whose retry came too late.
 */
function toJob(row: Row, now: Date): PrintJob {
  const expired = row.status === 'pending' && row.expiresAt <= now;
  return {
    id: row.id,
    locationId: row.locationId,
    printerId: row.printerId,
    kind: row.kind,
    orderId: row.orderId,
    ticketId: row.ticketId,
    status: expired ? 'needs_check' : row.status,
    expired: expired || row.lastCode === EXPIRED,
    stale:
      row.status === 'claimed' &&
      row.claimedAt !== null &&
      now.getTime() - row.claimedAt.getTime() >= PRINT_JOB_ANSWER_TIMEOUT_MS,
    attempts: row.attempts,
    lastCode: expired ? EXPIRED : row.lastCode,
    notBefore: row.notBefore.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    claimedAt: row.claimedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

function jobSnapshot(
  row: Pick<
    Row,
    | 'id'
    | 'locationId'
    | 'printerId'
    | 'kind'
    | 'orderId'
    | 'ticketId'
    | 'status'
    | 'attempts'
    | 'lastCode'
  >,
) {
  return snapshot('print_job', {
    id: row.id,
    locationId: row.locationId,
    printerId: row.printerId,
    kind: row.kind,
    orderId: row.orderId,
    ticketId: row.ticketId,
    status: row.status,
    attempts: row.attempts,
    lastCode: row.lastCode,
  });
}
