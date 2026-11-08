import { z } from 'zod';
import { type PrinterSettings, printerSettingsSchema } from '../native-print';
import { PREP_STATIONS } from './catalog';

/**
 * Printers as a list per location (ADR 0033, docs/modules/android-app.md → Printers). Each printer prints bills
 * and/or the tickets of chosen stations; one printer may serve several stations and one station may print on several
 * printers. Stations are linked by key, so "stations as a list" later needs no printer changes. A new printer starts
 * switched off; printers are archived, never deleted.
 */

/** Station keys a printer can print tickets for: today's stations (ADR 0025). */
export const PRINTER_STATION_KEYS = PREP_STATIONS;
export type PrinterStationKey = (typeof PRINTER_STATION_KEYS)[number];

export const PRINTER_NAME_MAX_LENGTH = 60;

const name = z.string().trim().min(1).max(PRINTER_NAME_MAX_LENGTH);
const stations = z
  .array(z.enum(PRINTER_STATION_KEYS))
  .max(PRINTER_STATION_KEYS.length)
  .refine((keys) => new Set(keys).size === keys.length, 'pos.printer_station_twice');

const { host, port, widthDots, cutter, imageMode } = printerSettingsSchema.shape;

/** New printers are always created switched off: `enabled` isn't accepted here. */
export const createPrinterRequestSchema = z.strictObject({
  locationId: z.uuid(),
  name,
  host,
  port,
  widthDots,
  cutter,
  imageMode,
  printsBills: z.boolean(),
  stations,
});

export const updatePrinterRequestSchema = z
  .strictObject({
    name,
    host,
    port,
    widthDots,
    cutter,
    imageMode,
    printsBills: z.boolean(),
    stations,
    enabled: z.boolean(),
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, 'validation.empty_update');

export const printerQuerySchema = z.object({ locationId: z.uuid() });

export const printerSchema = z.object({
  id: z.uuid(),
  locationId: z.uuid(),
  name: z.string(),
  host: z.string(),
  port: z.number().int(),
  widthDots: z.number().int(),
  cutter: z.boolean(),
  imageMode: z.enum(['gsV0', 'escStar']),
  enabled: z.boolean(),
  printsBills: z.boolean(),
  /** Read forward-compatibly: a station key this release doesn't know is dropped, not an error. */
  stations: z
    .array(z.string())
    .transform((keys) =>
      keys.filter((k): k is PrinterStationKey =>
        (PRINTER_STATION_KEYS as readonly string[]).includes(k),
      ),
    ),
  archivedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const printerListResponseSchema = z.object({ data: z.array(printerSchema) });

export type CreatePrinterRequest = z.infer<typeof createPrinterRequestSchema>;
export type UpdatePrinterRequest = z.infer<typeof updatePrinterRequestSchema>;
export type PrinterQuery = z.infer<typeof printerQuerySchema>;
export type Printer = z.infer<typeof printerSchema>;
export type PrinterListResponse = z.infer<typeof printerListResponseSchema>;

/** What the print object takes for a printer (ADR 0032). */
export function printerSettingsOf(p: Printer): PrinterSettings {
  return {
    host: p.host,
    port: p.port,
    widthDots: p.widthDots,
    cutter: p.cutter,
    imageMode: p.imageMode,
  };
}

/** Printers that print the bills of a location now: switched on, not archived, bills ticked. */
export function receiptPrinters(printers: readonly Printer[]): Printer[] {
  return printers.filter((p) => p.enabled && p.printsBills && p.archivedAt === null);
}

/**
 * Which receipt printer a bill goes to (ADR 0033): the device's default if it still prints bills here, else the only
 * receipt printer, else the caller asks which one (and keeps the answer as the device's default). None: the Android
 * print screen, as without printers.
 */
export function billPrinterFor(
  printers: readonly Printer[],
  deviceDefault: string | null,
):
  | { kind: 'printer'; printer: Printer }
  | { kind: 'choose'; options: Printer[] }
  | { kind: 'none' } {
  const options = receiptPrinters(printers);
  const preferred = options.find((p) => p.id === deviceDefault);
  if (preferred) return { kind: 'printer', printer: preferred };
  if (options.length === 1) return { kind: 'printer', printer: options[0]! };
  if (options.length > 1) return { kind: 'choose', options };
  return { kind: 'none' };
}
