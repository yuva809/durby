import { z } from 'zod';
import { NATIVE_PRINT_CODES, type NativePrintCode } from '../native-print';

/**
 * Print jobs (ADR 0033 §10–12, docs/modules/android-app.md → Print jobs): what a location's tills print on its
 * printers. A sent ticket queues one job per printer that is on and serves its station; a device without the app
 * queues a bill for a receipt printer. A till with the app polls, claims a job (exactly one till wins), prints it
 * through the print object and reports the answer code.
 */

export const PRINT_JOB_KINDS = ['ticket', 'bill'] as const;
export const PRINT_JOB_STATUSES = [
  'pending',
  'claimed',
  'printed',
  'failed',
  'needs_check',
] as const;
export type PrintJobKind = (typeof PRINT_JOB_KINDS)[number];
export type PrintJobStatus = (typeof PRINT_JOB_STATUSES)[number];

/** How often a till inside the app asks for due jobs (until RT.1's server-sent events). */
export const PRINT_JOB_POLL_MS = 1_500;
/** A claimed job without an answer this long may have printed or not: it needs a check, never a silent retry. */
export const PRINT_JOB_ANSWER_TIMEOUT_MS = 60_000;
/** A job still waiting this long shows a warning. */
export const PRINT_JOB_WAIT_WARNING_MS = 10_000;

/** Nothing reached the paper: the printer wasn't reachable or refused before the job was sent. */
const NOTHING_PRINTED: readonly NativePrintCode[] = [
  'print.printer_unreachable',
  'print.paper_out',
  'print.cover_open',
];
/** Lost while sending, or before: the app says which with `nothingPrinted` (version 1 doesn't). */
const MAYBE_PRINTED: readonly NativePrintCode[] = [
  'print.printer_timeout',
  'print.printer_disconnected',
];

/**
 * What an answer does to a job (ADR 0033 §12). `retry`: nothing can have printed, so it goes back to the queue after
 * a wait. `needs_check`: it may have printed, so only a person reprints it. `failed`: it can't print as it is (no
 * printer, an address outside the rules, a broken picture), and retrying wouldn't help.
 */
export function printJobOutcome(
  code: NativePrintCode,
  nothingPrinted = false,
): 'printed' | 'retry' | 'needs_check' | 'failed' {
  if (code === 'print.sent') return 'printed';
  if (NOTHING_PRINTED.includes(code)) return 'retry';
  if (MAYBE_PRINTED.includes(code)) return nothingPrinted ? 'retry' : 'needs_check';
  return 'failed';
}

/** The wait before retry number `attempts` (1, 2, …): 5 s, doubling, at most a minute. */
export function printJobRetryDelayMs(attempts: number): number {
  return Math.min(60_000, 5_000 * 2 ** Math.max(0, attempts - 1));
}

export const printJobQuerySchema = z.object({ locationId: z.uuid() });

export const claimPrintJobRequestSchema = z.strictObject({ locationId: z.uuid() });

export const printJobResultRequestSchema = z.strictObject({
  code: z.enum(NATIVE_PRINT_CODES),
  /** Version 1.1 of the app: the connection failed before any byte of the job was sent. */
  nothingPrinted: z.boolean().optional(),
});

/** A bill from a device without the app, for a receipt printer of the order's location. */
export const queueBillPrintJobRequestSchema = z.strictObject({
  orderId: z.uuid(),
  printerId: z.uuid(),
});

export const printJobSchema = z.object({
  id: z.uuid(),
  locationId: z.uuid(),
  printerId: z.uuid(),
  kind: z.enum(PRINT_JOB_KINDS),
  orderId: z.uuid(),
  ticketId: z.uuid().nullable(),
  status: z.enum(PRINT_JOB_STATUSES),
  /** Claimed and unanswered past PRINT_JOB_ANSWER_TIMEOUT_MS: shown as "check printer". */
  stale: z.boolean(),
  /**
   * Too old to print by itself (`pos.printJobMaxAgeSeconds`): never polled or claimed; shown as `needs_check` with
   * `print.expired` until someone reprints it.
   */
  expired: z.boolean(),
  attempts: z.number().int(),
  lastCode: z.string().nullable(),
  notBefore: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  claimedAt: z.iso.datetime().nullable(),
  completedAt: z.iso.datetime().nullable(),
});

/** The till's poll: due jobs, oldest first (ids only: the claim decides who prints which). */
export const duePrintJobsResponseSchema = z.object({ data: z.array(z.object({ id: z.uuid() })) });

export const claimPrintJobResponseSchema = z.object({ job: printJobSchema.nullable() });

/** What the warnings need (ADR 0033 §12), at one location. */
export const printJobStatusSchema = z.object({
  /** The last poll of a till with the app; null when none polled lately. */
  tillSeenAt: z.iso.datetime().nullable(),
  /**
   * The till that polled last has been signed out since (logout, the 30-day cap, a revoked session), so it can't
   * print until someone signs in on it again. Optional for answers from an api without it (expand/contract).
   */
  tillSignedOut: z.boolean().optional(),
  /** Pending jobs older than PRINT_JOB_WAIT_WARNING_MS. */
  waiting: z.object({ count: z.number().int(), oldestAt: z.iso.datetime().nullable() }),
  /** Waiting printers with their last answer (not reachable, paper out, …); expired jobs are in `attention`. */
  retrying: z.array(
    z.object({
      printerId: z.uuid(),
      printerName: z.string(),
      lastCode: z.string(),
      count: z.number().int(),
    }),
  ),
  /** Jobs a person has to look at: may have printed (check, then reprint), can't print, or too old. */
  attention: z.array(printJobSchema.extend({ printerName: z.string(), orderNumber: z.string() })),
});

export type PrintJob = z.infer<typeof printJobSchema>;
export type PrintJobQuery = z.infer<typeof printJobQuerySchema>;
export type ClaimPrintJobRequest = z.infer<typeof claimPrintJobRequestSchema>;
export type PrintJobResultRequest = z.infer<typeof printJobResultRequestSchema>;
export type QueueBillPrintJobRequest = z.infer<typeof queueBillPrintJobRequestSchema>;
export type DuePrintJobsResponse = z.infer<typeof duePrintJobsResponseSchema>;
export type ClaimPrintJobResponse = z.infer<typeof claimPrintJobResponseSchema>;
export type PrintJobStatusResponse = z.infer<typeof printJobStatusSchema>;
