import { z } from 'zod';

/**
 * Messages between the Durby web and the Durby Android app's print object (ADR 0032, docs/modules/android-app.md →
 * Print protocol). The app checks every message itself; these schemas are what the web sends and expects back.
 */

export const NATIVE_PRINT_PROTOCOL = 1;
/** The name of the object the app adds to allow-listed pages (`window.durbyPrint`). */
export const NATIVE_PRINT_OBJECT = 'durbyPrint';
/** Largest image the app accepts, decoded. */
export const NATIVE_PRINT_MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const PRINTER_PORTS = [9100, 9101, 9102] as const;

/** Answer codes; the web shows each through a label. */
export const NATIVE_PRINT_CODES = [
  'print.sent',
  'print.no_printer',
  'print.host_not_allowed',
  'print.port_not_allowed',
  'print.payload_invalid',
  'print.printer_unreachable',
  'print.printer_timeout',
  'print.printer_disconnected',
  'print.paper_out',
  'print.cover_open',
] as const;
export type NativePrintCode = (typeof NATIVE_PRINT_CODES)[number];

const OCTET = /^(0|[1-9][0-9]{0,2})$/;

/**
 * A dotted-decimal IPv4 literal in 10.0.0.0/8, 172.16.0.0/12 or 192.168.0.0/16. No names, no other spellings:
 * the app never resolves anything, so nothing here can lead to the internet or the device itself.
 */
export function isAllowedPrinterHost(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4 || !parts.every((p) => OCTET.test(p))) return false;
  const [a, b, c, d] = parts.map(Number) as [number, number, number, number];
  if ([a, b, c, d].some((n) => n > 255)) return false;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export function isAllowedPrinterPort(port: number): boolean {
  return (PRINTER_PORTS as readonly number[]).includes(port);
}

export const printerSettingsSchema = z.strictObject({
  host: z.string().refine(isAllowedPrinterHost, 'print.host_not_allowed'),
  port: z.number().int().refine(isAllowedPrinterPort, 'print.port_not_allowed'),
  /** 58 mm paper: 384. 80 mm: 576 (some printers 512). */
  widthDots: z.number().int().min(8).max(2040).multipleOf(8),
  cutter: z.boolean(),
  imageMode: z.enum(['gsV0', 'escStar']),
});
export type PrinterSettings = z.infer<typeof printerSettingsSchema>;

/** Bytes a base64 string decodes to (without decoding it). */
function base64Bytes(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return (data.length / 4) * 3 - padding;
}

/** 1 bit per dot, row-major, rows padded to whole bytes, most significant bit = leftmost dot, 1 = black. */
export const printImageSchema = z
  .strictObject({
    width: z.number().int().min(8).max(2040),
    height: z.number().int().min(1).max(20_000),
    data: z
      .string()
      .max(Math.ceil(NATIVE_PRINT_MAX_IMAGE_BYTES / 3) * 4)
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  })
  .refine((i) => base64Bytes(i.data) === Math.ceil(i.width / 8) * i.height, {
    message: 'print.payload_invalid',
    path: ['data'],
  });
export type PrintImage = z.infer<typeof printImageSchema>;

export const nativeInfoRequestSchema = z.strictObject({
  version: z.literal(NATIVE_PRINT_PROTOCOL),
  type: z.literal('info'),
});

export const nativePrintRequestSchema = z.strictObject({
  version: z.literal(NATIVE_PRINT_PROTOCOL),
  type: z.literal('print'),
  /** One per tap; Retry sends the same id, and the app answers it from memory without printing again. */
  jobId: z.uuid(),
  image: printImageSchema,
  /** Version 1.1: the location's printer. Version 1 apps ignore it and use the device's printer. */
  printer: printerSettingsSchema.optional(),
});
export type NativePrintRequest = z.infer<typeof nativePrintRequestSchema>;

export const nativeInfoAnswerSchema = z.object({
  type: z.literal('info'),
  appVersion: z.string(),
  protocol: z.number().int(),
  /** The device's bill printer (version 1); null when none is set. */
  printer: z.object({ widthDots: z.number().int().min(8).max(2040) }).nullable(),
});
export type NativeInfoAnswer = z.infer<typeof nativeInfoAnswerSchema>;

export const nativePrintAnswerSchema = z.object({
  type: z.literal('print'),
  jobId: z.uuid(),
  state: z.enum(['sent', 'failed']),
  code: z.enum(NATIVE_PRINT_CODES),
});
export type NativePrintAnswer = z.infer<typeof nativePrintAnswerSchema>;
