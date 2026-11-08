import { Inject, Injectable } from '@nestjs/common';
import {
  type ClaimPrinterCommandResponse,
  type CompletePrinterCommandRequest,
  type CreatePrinterCommandRequest,
  PRINTER_COMMAND_LIFETIME_MS,
  type PrinterCommand,
  type PrinterCommandKind,
  type PrinterCommandResult,
  printerCommandResultSchema,
} from '@durby/shared';
import { auditActor, AuditService, snapshot } from '../../platform/audit';
import { ApiError } from '../../platform/http';
import { IdempotencyService } from '../../platform/idempotency';
import { AccessService } from '../../platform/rbac';
import { TENANT_PRISMA, TenantContext, type TenantPrismaClient } from '../../platform/tenancy';
import { posErrors } from './pos-errors';
import { PrintersService } from './printers.service';

const SELECT = {
  id: true,
  locationId: true,
  kind: true,
  printerId: true,
  status: true,
  result: true,
  createdAt: true,
  expiresAt: true,
  completedAt: true,
} as const;

interface Row {
  id: string;
  locationId: string;
  kind: PrinterCommandKind;
  printerId: string | null;
  status: PrinterCommand['status'];
  result: unknown;
  createdAt: Date;
  expiresAt: Date;
  completedAt: Date | null;
}

/** The same row as a raw `RETURNING` gives it. */
interface RawRow {
  id: string;
  location_id: string;
  kind: PrinterCommandKind;
  printer_id: string | null;
  status: PrinterCommand['status'];
  result: unknown;
  created_at: Date;
  expires_at: Date;
  completed_at: Date | null;
}

const fromRaw = (r: RawRow): Row => ({
  id: r.id,
  locationId: r.location_id,
  kind: r.kind,
  printerId: r.printer_id,
  status: r.status,
  result: r.result,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  completedAt: r.completed_at,
});

/**
 * Remote printer commands (ADR 0032 §15): Owner/Admin ask a location's Android till to find printers or to
 * print a test page. A till at the location claims the oldest open command with one atomic UPDATE, runs it
 * and posts the result. Commands expire 5 minutes after they were requested; rows are never deleted, and every
 * step is audited.
 */
@Injectable()
export class PrinterCommandsService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    private readonly tenantContext: TenantContext,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly printers: PrintersService,
  ) {}

  /** `platform.settings.manage` (the controller): Owner and Admin. */
  async request(body: CreatePrinterCommandRequest): Promise<PrinterCommand> {
    const { tenantId, userId } = this.tenantContext.require();
    return this.db.$transaction(async (tx) => {
      const location = await tx.location.findUnique({
        where: { id: body.locationId },
        select: { id: true },
      });
      if (!location) throw posErrors.locationNotFound();
      // A test print goes to one printer of this location (ADR 0033), on or off; Find printer to none.
      let printerId: string | null = null;
      if (body.kind === 'test_print') {
        if (!body.printerId) throw posErrors.printerRequired();
        printerId = (await this.printers.requireAt(tx, body.locationId, body.printerId)).id;
      }
      const now = new Date();
      const row = (await tx.posPrinterCommand.create({
        data: {
          tenantId,
          locationId: body.locationId,
          kind: body.kind,
          printerId,
          requestedByUserId: userId,
          createdAt: now,
          expiresAt: new Date(now.getTime() + PRINTER_COMMAND_LIFETIME_MS),
        },
        select: SELECT,
      })) as Row;
      await this.audit.record(tx, {
        action: 'pos.printer_command.requested',
        actor: auditActor.user(userId),
        entityId: row.id,
        after: commandSnapshot(row),
      });
      const response = toCommand(row, now);
      await this.idempotency.completeInTransaction(tx, response);
      return response;
    });
  }

  /** The location's latest commands, newest first (Settings → Printers). */
  async list(locationId: string): Promise<PrinterCommand[]> {
    const location = await this.db.location.findUnique({
      where: { id: locationId },
      select: { id: true },
    });
    if (!location) throw posErrors.locationNotFound();
    const rows = (await this.db.posPrinterCommand.findMany({
      where: { locationId },
      select: SELECT,
      orderBy: { createdAt: 'desc' },
      take: 10,
    })) as Row[];
    const now = new Date();
    return rows.map((r) => toCommand(r, now));
  }

  /** Open commands for a till at the location (`pos.bills.print` there): a cheap read, polled every 15 s. */
  async pending(locationId: string): Promise<PrinterCommand[]> {
    await this.tillAt(locationId);
    const now = new Date();
    const rows = (await this.db.posPrinterCommand.findMany({
      where: { locationId, status: 'pending', expiresAt: { gt: now } },
      select: SELECT,
      orderBy: { createdAt: 'asc' },
      take: 5,
    })) as Row[];
    return rows.map((r) => toCommand(r, now));
  }

  /**
   * One atomic UPDATE takes the oldest open command of the location: of two tills asking at once, exactly one
   * gets it (the row lock serializes them; the second sees `status` no longer `pending`).
   */
  async claim(locationId: string): Promise<ClaimPrinterCommandResponse> {
    const { userId } = this.tenantContext.require();
    await this.tillAt(locationId);
    return this.db.$transaction(async (tx) => {
      const [raw] = await tx.$queryRaw<RawRow[]>`
        UPDATE "pos_printer_commands"
           SET "status" = 'claimed', "claimed_at" = now(), "claimed_by_user_id" = ${userId}::uuid
         WHERE "id" = (
                 SELECT "id" FROM "pos_printer_commands"
                  WHERE "location_id" = ${locationId}::uuid
                    AND "status" = 'pending' AND "expires_at" > now()
                  ORDER BY "created_at", "id"
                  LIMIT 1
               )
           AND "status" = 'pending' AND "expires_at" > now()
        RETURNING "id", "location_id", "kind", "printer_id", "status", "result", "created_at", "expires_at", "completed_at"`;
      const row = raw ? fromRaw(raw) : null;
      if (row) {
        await this.audit.record(tx, {
          action: 'pos.printer_command.claimed',
          actor: auditActor.user(userId),
          entityId: row.id,
          before: commandSnapshot({ ...row, status: 'pending' }),
          after: commandSnapshot(row),
        });
      }
      const response = { command: row ? toCommand(row, new Date()) : null };
      await this.idempotency.completeInTransaction(tx, response);
      return response;
    });
  }

  /** The claiming till's result; only before the command expires. */
  async complete(id: string, body: CompletePrinterCommandRequest): Promise<PrinterCommand> {
    const { userId } = this.tenantContext.require();
    const found = await this.db.posPrinterCommand.findUnique({
      where: { id },
      select: { locationId: true, kind: true },
    });
    if (!found || !(await this.access.can('pos.bills.print', { locationId: found.locationId }))) {
      throw posErrors.printerCommandNotFound();
    }
    const result = body.result;
    const isFound = 'printers' in result;
    if (isFound && found.kind !== 'find_printers') {
      throw new ApiError(400, 'validation.failed', 'A test print answers with a code.', {
        issues: [{ path: ['result'], code: 'invalid_union', message: 'Expected a code.' }],
      });
    }
    const status = isFound || result.code === 'print.sent' ? 'done' : 'failed';
    return this.db.$transaction(async (tx) => {
      const [raw] = await tx.$queryRaw<RawRow[]>`
        UPDATE "pos_printer_commands"
           SET "status" = ${status}::"pos_printer_command_status",
               "result" = ${JSON.stringify(result)}::jsonb,
               "completed_at" = now()
         WHERE "id" = ${id}::uuid
           AND "status" = 'claimed' AND "claimed_by_user_id" = ${userId}::uuid AND "expires_at" > now()
        RETURNING "id", "location_id", "kind", "printer_id", "status", "result", "created_at", "expires_at", "completed_at"`;
      if (!raw) {
        const current = await tx.posPrinterCommand.findUnique({
          where: { id },
          select: { status: true, expiresAt: true },
        });
        if (!current) throw posErrors.printerCommandNotFound();
        if (current.status === 'claimed' && current.expiresAt <= new Date()) {
          throw posErrors.printerCommandExpired();
        }
        throw posErrors.printerCommandNotClaimed();
      }
      const row = fromRaw(raw);
      await this.audit.record(tx, {
        action: 'pos.printer_command.completed',
        actor: auditActor.user(userId),
        entityId: row.id,
        before: commandSnapshot({ ...row, status: 'claimed', result: null }),
        after: commandSnapshot(row),
      });
      const response = toCommand(row, new Date());
      await this.idempotency.completeInTransaction(tx, response);
      return response;
    });
  }

  /** A till may only work for a location where it prints bills; any other location doesn't exist for it. */
  private async tillAt(locationId: string): Promise<void> {
    if (!(await this.access.can('pos.bills.print', { locationId }))) {
      throw posErrors.locationNotFound();
    }
    // An owner may print everywhere: the location must still be one of this organization's (RLS).
    const location = await this.db.location.findUnique({
      where: { id: locationId },
      select: { id: true },
    });
    if (!location) throw posErrors.locationNotFound();
  }
}

function toCommand(row: Row, now: Date): PrinterCommand {
  return {
    id: row.id,
    locationId: row.locationId,
    kind: row.kind,
    printerId: row.printerId,
    status: row.status,
    expired: (row.status === 'pending' || row.status === 'claimed') && row.expiresAt <= now,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    result: parseResult(row.result),
  };
}

function parseResult(value: unknown): PrinterCommandResult | null {
  return value === null ? null : (printerCommandResultSchema.safeParse(value).data ?? null);
}

function commandSnapshot(
  row: Pick<Row, 'id' | 'locationId' | 'kind' | 'printerId' | 'status' | 'result'>,
) {
  const result = parseResult(row.result);
  return snapshot('printer_command', {
    id: row.id,
    locationId: row.locationId,
    kind: row.kind,
    printerId: row.printerId,
    status: row.status,
    resultCode: result === null ? null : 'printers' in result ? 'found' : result.code,
    printerCount: result !== null && 'printers' in result ? result.printers.length : null,
  });
}
