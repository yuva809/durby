import { z } from 'zod';
import {
  DISCOVERED_PRINTER_STATUSES,
  isAllowedPrinterHost,
  isAllowedPrinterPort,
  NATIVE_PRINT_CODES,
} from '../native-print';

/**
 * Remote printer commands (ADR 0032 §15, docs/modules/android-app.md → Remote commands): Owner/Admin ask a
 * location's Android till to find printers or to print a test page. The till claims a command, runs it through
 * the print object and posts the result. A command expires 5 minutes after it was requested.
 */

export const PRINTER_COMMAND_KINDS = ['find_printers', 'test_print'] as const;
export const PRINTER_COMMAND_STATUSES = ['pending', 'claimed', 'done', 'failed'] as const;
export const PRINTER_COMMAND_LIFETIME_MS = 5 * 60 * 1000;
/** How often a till inside the app asks for open commands. */
export const PRINTER_COMMAND_POLL_MS = 15_000;

/** What the till found: addresses and statuses only. */
export const printerCommandFoundSchema = z.strictObject({
  subnet: z
    .string()
    .regex(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.0\/24$/)
    .nullable(),
  printers: z
    .array(
      z.strictObject({
        host: z.string().refine(isAllowedPrinterHost),
        port: z.number().int().refine(isAllowedPrinterPort),
        status: z.enum(DISCOVERED_PRINTER_STATUSES),
      }),
    )
    .max(64),
});

/** A test print's answer, or why a command couldn't run (`print.no_answer`: the app stayed silent). */
export const printerCommandCodeSchema = z.strictObject({
  code: z.enum([...NATIVE_PRINT_CODES, 'print.no_answer']),
});

export const printerCommandResultSchema = z.union([
  printerCommandFoundSchema,
  printerCommandCodeSchema,
]);

export const createPrinterCommandRequestSchema = z.strictObject({
  locationId: z.uuid(),
  kind: z.enum(PRINTER_COMMAND_KINDS),
  /**
   * The printer a test print is for (ADR 0033), required for a test print: the till prints on it, on or off, and
   * the test page names it. Find printer has none.
   */
  printerId: z.uuid().optional(),
});

export const printerCommandQuerySchema = z.object({ locationId: z.uuid() });

export const claimPrinterCommandRequestSchema = z.strictObject({ locationId: z.uuid() });

export const completePrinterCommandRequestSchema = z.strictObject({
  result: printerCommandResultSchema,
});

export const printerCommandSchema = z.object({
  id: z.uuid(),
  locationId: z.uuid(),
  kind: z.enum(PRINTER_COMMAND_KINDS),
  /** The printer of a test print; null for Find printer. */
  printerId: z.uuid().nullable(),
  status: z.enum(PRINTER_COMMAND_STATUSES),
  /** Pending or claimed past `expiresAt`: no till finished it in time. */
  expired: z.boolean(),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
  result: printerCommandResultSchema.nullable(),
});

export const printerCommandListResponseSchema = z.object({ data: z.array(printerCommandSchema) });

/** Claim answer: the command this till now runs, or null when nothing is open at the location. */
export const claimPrinterCommandResponseSchema = z.object({
  command: printerCommandSchema.nullable(),
});

export type PrinterCommandKind = (typeof PRINTER_COMMAND_KINDS)[number];
export type PrinterCommandResult = z.infer<typeof printerCommandResultSchema>;
export type PrinterCommand = z.infer<typeof printerCommandSchema>;
export type CreatePrinterCommandRequest = z.infer<typeof createPrinterCommandRequestSchema>;
export type PrinterCommandQuery = z.infer<typeof printerCommandQuerySchema>;
export type ClaimPrinterCommandRequest = z.infer<typeof claimPrinterCommandRequestSchema>;
export type CompletePrinterCommandRequest = z.infer<typeof completePrinterCommandRequestSchema>;
export type PrinterCommandListResponse = z.infer<typeof printerCommandListResponseSchema>;
export type ClaimPrinterCommandResponse = z.infer<typeof claimPrinterCommandResponseSchema>;
