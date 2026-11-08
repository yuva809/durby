import { Inject, Injectable } from '@nestjs/common';
import type {
  CreatePrinterRequest,
  Printer,
  PrinterStationKey,
  UpdatePrinterRequest,
} from '@durby/shared';
import { auditActor, AuditService, snapshot } from '../../platform/audit';
import { IdempotencyService } from '../../platform/idempotency';
import {
  TENANT_PRISMA,
  TenantContext,
  type TenantPrismaClient,
  type TenantTransactionClient,
} from '../../platform/tenancy';
import { isUniqueViolation, posErrors } from './pos-errors';

type Tx = TenantTransactionClient;

const SELECT = {
  id: true,
  locationId: true,
  name: true,
  host: true,
  port: true,
  widthDots: true,
  cutter: true,
  imageMode: true,
  enabled: true,
  printsBills: true,
  archivedAt: true,
  createdAt: true,
  updatedAt: true,
  stations: { select: { stationKey: true }, orderBy: { stationKey: 'asc' } },
} as const;

interface Row {
  id: string;
  locationId: string;
  name: string;
  host: string;
  port: number;
  widthDots: number;
  cutter: boolean;
  imageMode: string;
  enabled: boolean;
  printsBills: boolean;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  stations: { stationKey: string }[];
}

/**
 * Printers per location (ADR 0033): Owner and Admin add, change and archive them (`platform.settings.manage`, the
 * controller); tills read them with the bill layout. A new printer starts switched off, so it prints nothing until
 * someone switches it on after a test print. Archived, never deleted: print jobs and the audit keep pointing at it.
 */
@Injectable()
export class PrintersService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    private readonly tenantContext: TenantContext,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
  ) {}

  /** The location's printers that aren't archived, by name. */
  async list(locationId: string): Promise<Printer[]> {
    return this.db.$transaction(async (tx) => {
      await this.requireLocation(tx, locationId);
      return this.listIn(tx, locationId);
    });
  }

  /** The same, inside a caller's transaction (the bill layout). */
  async listIn(tx: Tx, locationId: string): Promise<Printer[]> {
    const rows = (await tx.posPrinter.findMany({
      where: { locationId, archivedAt: null },
      select: SELECT,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    })) as Row[];
    return rows.map(toPrinter);
  }

  async create(body: CreatePrinterRequest): Promise<Printer> {
    const { tenantId, userId } = this.tenantContext.require();
    return this.write(async (tx) => {
      await this.requireLocation(tx, body.locationId);
      await this.requireFreeName(tx, body.locationId, body.name, null);
      const row = await tx.posPrinter.create({
        data: {
          tenantId,
          locationId: body.locationId,
          name: body.name,
          host: body.host,
          port: body.port,
          widthDots: body.widthDots,
          cutter: body.cutter,
          imageMode: body.imageMode,
          printsBills: body.printsBills,
          // Off until switched on after a test print (ADR 0033).
          enabled: false,
          // The organization comes from the printer (composite foreign key).
          stations: { create: body.stations.map((stationKey) => ({ stationKey })) },
        },
        select: SELECT,
      });
      const printer = toPrinter(row);
      await this.audit.record(tx, {
        action: 'pos.printer.created',
        actor: auditActor.user(userId),
        entityId: printer.id,
        after: printerSnapshot(printer),
      });
      await this.idempotency.completeInTransaction(tx, printer);
      return printer;
    });
  }

  async update(id: string, body: UpdatePrinterRequest): Promise<Printer> {
    const { tenantId, userId } = this.tenantContext.require();
    return this.write(async (tx) => {
      const before = await this.requireActive(tx, id);
      if (body.name !== undefined) {
        await this.requireFreeName(tx, before.locationId, body.name, id);
      }
      if (body.stations !== undefined) {
        await tx.posPrinterStation.deleteMany({ where: { printerId: id } });
        await tx.posPrinterStation.createMany({
          data: body.stations.map((stationKey: PrinterStationKey) => ({
            tenantId,
            printerId: id,
            stationKey,
          })),
        });
      }
      const row = await tx.posPrinter.update({
        where: { id },
        data: {
          name: body.name,
          host: body.host,
          port: body.port,
          widthDots: body.widthDots,
          cutter: body.cutter,
          imageMode: body.imageMode,
          printsBills: body.printsBills,
          enabled: body.enabled,
        },
        select: SELECT,
      });
      const after = toPrinter(row);
      await this.audit.record(tx, {
        action: 'pos.printer.updated',
        actor: auditActor.user(userId),
        entityId: id,
        before: printerSnapshot(before),
        after: printerSnapshot(after),
      });
      await this.idempotency.completeInTransaction(tx, after);
      return after;
    });
  }

  /** Archived printers print nothing and leave the lists; their name can be used again. */
  async archive(id: string): Promise<Printer> {
    const { userId } = this.tenantContext.require();
    return this.write(async (tx) => {
      const before = await this.requireActive(tx, id);
      const row = await tx.posPrinter.update({
        where: { id },
        data: { archivedAt: new Date(), enabled: false },
        select: SELECT,
      });
      const after = toPrinter(row);
      await this.audit.record(tx, {
        action: 'pos.printer.archived',
        actor: auditActor.user(userId),
        entityId: id,
        before: printerSnapshot(before),
        after: printerSnapshot(after),
      });
      await this.idempotency.completeInTransaction(tx, after);
      return after;
    });
  }

  /** A printer that isn't archived, at a location (remote test prints); else 404. */
  async requireAt(tx: Tx, locationId: string, id: string): Promise<Printer> {
    const printer = await this.requireActive(tx, id);
    if (printer.locationId !== locationId) throw posErrors.printerNotFound();
    return printer;
  }

  /** Writes; a name taken in a race (the partial unique index) answers as taken, not 500. */
  private async write<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    try {
      return await this.db.$transaction(work);
    } catch (error) {
      if (isUniqueViolation(error)) throw posErrors.printerNameTaken();
      throw error;
    }
  }

  private async requireLocation(tx: Tx, locationId: string): Promise<void> {
    const location = await tx.location.findUnique({
      where: { id: locationId },
      select: { id: true },
    });
    if (!location) throw posErrors.locationNotFound();
  }

  private async requireActive(tx: Tx, id: string): Promise<Printer> {
    const row = await tx.posPrinter.findUnique({ where: { id }, select: SELECT });
    if (!row || row.archivedAt !== null) throw posErrors.printerNotFound();
    return toPrinter(row);
  }

  /** Names are unique per location among printers that aren't archived, ignoring case. */
  private async requireFreeName(
    tx: Tx,
    locationId: string,
    name: string,
    except: string | null,
  ): Promise<void> {
    const taken = await tx.posPrinter.findFirst({
      where: {
        locationId,
        archivedAt: null,
        name: { equals: name, mode: 'insensitive' },
        ...(except ? { id: { not: except } } : {}),
      },
      select: { id: true },
    });
    if (taken) throw posErrors.printerNameTaken();
  }
}

function toPrinter(row: Row): Printer {
  return {
    id: row.id,
    locationId: row.locationId,
    name: row.name,
    host: row.host,
    port: row.port,
    widthDots: row.widthDots,
    cutter: row.cutter,
    imageMode: row.imageMode === 'escStar' ? 'escStar' : 'gsV0',
    enabled: row.enabled,
    printsBills: row.printsBills,
    stations: row.stations.map((s) => s.stationKey) as PrinterStationKey[],
    archivedAt: row.archivedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function printerSnapshot(p: Printer) {
  return snapshot('printer', {
    id: p.id,
    locationId: p.locationId,
    name: p.name,
    host: p.host,
    port: p.port,
    widthDots: p.widthDots,
    cutter: p.cutter,
    imageMode: p.imageMode,
    enabled: p.enabled,
    printsBills: p.printsBills,
    stations: p.stations,
    archivedAt: p.archivedAt,
  });
}
