import {
  claimPrintJobResponseSchema,
  duePrintJobsResponseSchema,
  type NativePrintCode,
  type Order,
  orderSchema,
  type PrepStation,
  type Printer,
  printerSettingsOf,
  type PrintImage,
  type PrintJob,
  printJobSchema,
  type PrintJobStatusResponse,
  printJobStatusSchema,
} from '@durby/shared';
import { type Api, read, type Result, write } from '../api-call';
import { ActionKey } from '../idempotency';
import type { NativePrinter } from '../print/native';

/** Print jobs (ADR 0033 §10–12), parsed with the shared schemas. */

const q = (locationId: string) => `?locationId=${encodeURIComponent(locationId)}`;

export const loadDuePrintJobs = (
  store: Api,
  locationId: string,
): Promise<Result<{ id: string }[]>> =>
  read(store, `/api/v1/pos/print-jobs/due${q(locationId)}`, duePrintJobsResponseSchema).then((r) =>
    r.ok ? { ok: true, data: r.data.data } : r,
  );

export const claimPrintJob = (
  store: Api,
  action: ActionKey,
  locationId: string,
): Promise<Result<{ job: PrintJob | null } | null>> =>
  write(
    store,
    action,
    '/api/v1/pos/print-jobs/claim',
    'POST',
    { locationId },
    claimPrintJobResponseSchema,
  );

export const answerPrintJob = (
  store: Api,
  action: ActionKey,
  id: string,
  code: NativePrintCode,
): Promise<Result<PrintJob | null>> =>
  write(store, action, `/api/v1/pos/print-jobs/${id}/result`, 'POST', { code }, printJobSchema);

/** Reprint from the till (`pos.bills.print`), or from a station's screen for its own tickets. */
export const reprintPrintJob = (
  store: Api,
  action: ActionKey,
  id: string,
  station?: PrepStation,
): Promise<Result<PrintJob | null>> =>
  write(
    store,
    action,
    station
      ? `/api/v1/pos/stations/${station}/print-jobs/${id}/reprint`
      : `/api/v1/pos/print-jobs/${id}/reprint`,
    'POST',
    {},
    printJobSchema,
  );

/** A bill from a device without the app, for a receipt printer: a second tap gets the waiting job. */
export const queueBillPrintJob = (
  store: Api,
  action: ActionKey,
  orderId: string,
  printerId: string,
): Promise<Result<PrintJob | null>> =>
  write(
    store,
    action,
    '/api/v1/pos/print-jobs/bill',
    'POST',
    { orderId, printerId },
    printJobSchema,
  );

/** The warnings: the location's (till, order page), or one station's (its screen). */
export const loadPrintStatus = (
  store: Api,
  locationId: string,
  station?: PrepStation,
): Promise<Result<PrintJobStatusResponse>> =>
  read(
    store,
    station
      ? `/api/v1/pos/stations/${station}/print-status${q(locationId)}`
      : `/api/v1/pos/print-jobs/status${q(locationId)}`,
    printJobStatusSchema,
  );

export const loadOrder = (store: Api, orderId: string): Promise<Result<Order>> =>
  read(store, `/api/v1/pos/orders/${orderId}`, orderSchema);

/** What running a job needs on the till. */
export interface JobDevice {
  printer: Pick<NativePrinter, 'print'>;
  /** The job's printer at the location, on or off (null: archived meanwhile). */
  printerFor: (printerId: string) => Promise<Printer | null>;
  /** The ticket or bill of the job, drawn at the printer's width. */
  render: (job: PrintJob, printer: Printer) => Promise<PrintImage>;
}

/** Runs one claimed job through the print object. Never throws: every end is an answer code. */
export async function runPrintJob(job: PrintJob, device: JobDevice): Promise<NativePrintCode> {
  const printer = await device.printerFor(job.printerId);
  if (!printer) return 'print.no_printer';
  let image: PrintImage;
  try {
    image = await device.render(job, printer);
  } catch {
    return 'print.payload_invalid';
  }
  // A new id per claim: a reprint prints again, while the app still refuses this claim twice.
  const outcome = await device.printer.print(
    crypto.randomUUID(),
    image,
    printerSettingsOf(printer),
  );
  // The app didn't answer in time: it may have printed, so a person checks (needs check, never a silent retry).
  return outcome.code === 'print.no_answer' ? 'print.printer_timeout' : outcome.code;
}

/** Runs `fn` one call at a time, in call order: what the till draws shares one hidden page. */
export function oneAtATime<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  let last: Promise<unknown> = Promise.resolve();
  return (...args) => {
    const run = last.then(() => fn(...args));
    last = run.catch(() => undefined);
    return run;
  };
}

/**
 * One poll of a till (every 1.5 s in the app): claims the due jobs it saw, oldest first (one till wins each), then
 * prints them in one lane per printer: a printer's jobs in order, different printers at the same time, so a bar
 * ticket doesn't wait for the kitchen printer. Returns the answer codes in claim order, for tests and logs ('idle':
 * nothing due; 'taken': another till got them).
 */
export async function pollPrintJobs(
  store: Api,
  locationId: string,
  device: JobDevice,
): Promise<'idle' | 'taken' | NativePrintCode[]> {
  const due = await loadDuePrintJobs(store, locationId);
  if (!due.ok || due.data.length === 0) return 'idle';
  const lanes = new Map<string, Promise<unknown>>();
  const runs: Promise<NativePrintCode>[] = [];
  for (let i = 0; i < due.data.length; i++) {
    const claimed = await claimPrintJob(store, new ActionKey(), locationId);
    const job = claimed.ok ? claimed.data?.job : null;
    if (!job) break;
    const run = (lanes.get(job.printerId) ?? Promise.resolve()).then(() =>
      printAndAnswer(store, job, device),
    );
    lanes.set(job.printerId, run);
    runs.push(run);
  }
  return runs.length > 0 ? Promise.all(runs) : 'taken';
}

async function printAndAnswer(
  store: Api,
  job: PrintJob,
  device: JobDevice,
): Promise<NativePrintCode> {
  const code = await runPrintJob(job, device);
  // One key for this answer: a retry after a lost response replays instead of failing as "not claimed".
  const action = new ActionKey();
  const sent = await answerPrintJob(store, action, job.id, code);
  if (!sent.ok && sent.code === 'unknown') await answerPrintJob(store, action, job.id, code);
  return code;
}
