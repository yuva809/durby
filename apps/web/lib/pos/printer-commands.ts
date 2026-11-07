import {
  claimPrinterCommandResponseSchema,
  type ClaimPrinterCommandResponse,
  type PrinterCommand,
  type PrinterCommandKind,
  printerCommandListResponseSchema,
  type PrinterCommandResult,
  printerCommandSchema,
  type PrinterSettings,
  type PrintImage,
} from '@durby/shared';
import { type Api, list, read, type Result, write } from '../api-call';
import { ActionKey } from '../idempotency';
import type { NativePrinter } from '../print/native';

/** Remote printer commands (ADR 0032 §15), parsed with the shared schemas. */

const q = (locationId: string) => `?locationId=${encodeURIComponent(locationId)}`;

export const requestPrinterCommand = (
  store: Api,
  action: ActionKey,
  locationId: string,
  kind: PrinterCommandKind,
): Promise<Result<PrinterCommand | null>> =>
  write(
    store,
    action,
    '/api/v1/pos/printer-commands',
    'POST',
    { locationId, kind },
    printerCommandSchema,
  );

export const loadPrinterCommands = (
  store: Api,
  locationId: string,
): Promise<Result<PrinterCommand[]>> =>
  read(
    store,
    `/api/v1/pos/printer-commands${q(locationId)}`,
    list(printerCommandListResponseSchema),
  );

export const loadPendingPrinterCommands = (
  store: Api,
  locationId: string,
): Promise<Result<PrinterCommand[]>> =>
  read(
    store,
    `/api/v1/pos/printer-commands/pending${q(locationId)}`,
    list(printerCommandListResponseSchema),
  );

export const claimPrinterCommand = (
  store: Api,
  action: ActionKey,
  locationId: string,
): Promise<Result<ClaimPrinterCommandResponse | null>> =>
  write(
    store,
    action,
    '/api/v1/pos/printer-commands/claim',
    'POST',
    { locationId },
    claimPrinterCommandResponseSchema,
  );

export const completePrinterCommand = (
  store: Api,
  action: ActionKey,
  id: string,
  result: PrinterCommandResult,
): Promise<Result<PrinterCommand | null>> =>
  write(
    store,
    action,
    `/api/v1/pos/printer-commands/${id}/result`,
    'POST',
    { result },
    printerCommandSchema,
  );

/** What running a command needs on the till. */
export interface CommandDevice {
  printer: Pick<NativePrinter, 'discover' | 'print'>;
  /** The location's saved bill printer, read when the command runs. */
  savedPrinter: () => Promise<PrinterSettings | null>;
  /** The test page at the printer's width. */
  renderTestPage: (widthDots: number) => Promise<PrintImage>;
}

/** Runs one claimed command through the print object. Never throws: every end is a result. */
export async function runPrinterCommand(
  kind: PrinterCommandKind,
  device: CommandDevice,
): Promise<PrinterCommandResult> {
  if (kind === 'find_printers') {
    const found = await device.printer.discover();
    return found ? { subnet: found.subnet, printers: found.printers } : { code: 'print.no_answer' };
  }
  const printer = await device.savedPrinter();
  if (!printer) return { code: 'print.no_printer' };
  let image: PrintImage;
  try {
    image = await device.renderTestPage(printer.widthDots);
  } catch {
    return { code: 'print.payload_invalid' };
  }
  const outcome = await device.printer.print(crypto.randomUUID(), image, printer);
  return { code: outcome.code };
}

/**
 * One poll of a till: if the location has an open command, claim it (one wins among the tills), run it and
 * post the result. Returns what it did, for tests and logs.
 */
export async function pollPrinterCommands(
  store: Api,
  locationId: string,
  device: CommandDevice,
): Promise<'idle' | 'taken' | PrinterCommandResult> {
  const pending = await loadPendingPrinterCommands(store, locationId);
  if (!pending.ok || pending.data.length === 0) return 'idle';
  const claimed = await claimPrinterCommand(store, new ActionKey(), locationId);
  const command = claimed.ok ? claimed.data?.command : null;
  if (!command) return 'taken';
  const result = await runPrinterCommand(command.kind, device);
  // One key for this result: a retry after a lost answer replays instead of failing as "not claimed".
  const action = new ActionKey();
  const sent = await completePrinterCommand(store, action, command.id, result);
  if (!sent.ok && sent.code === 'unknown')
    await completePrinterCommand(store, action, command.id, result);
  return result;
}
