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

/**
 * `pos.printers` (ADR 0032 §6): one slot per printer role, so kitchen and bar printers are added later as new
 * slots without renaming anything. Version 1 has the bill printer only.
 */
export const posPrintersSchema = z.strictObject({
  bill: printerSettingsSchema.nullable(),
});
export type PosPrinters = z.infer<typeof posPrintersSchema>;
export const DEFAULT_POS_PRINTERS: PosPrinters = { bill: null };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Only the keys `known` lists, for an object; anything else as it is (for the schema to judge). */
function pick(value: unknown, known: readonly string[]): unknown {
  if (!isRecord(value)) return value;
  return Object.fromEntries(known.filter((k) => Object.hasOwn(value, k)).map((k) => [k, value[k]]));
}

/**
 * Reading `pos.printers` forward-compatibly (ADR 0033): keys and printer fields this release doesn't know are dropped,
 * then the strict schema applies, so a value written by a later release never breaks this one (during a deploy or
 * after a rollback). Writes stay strict (`posPrintersSchema`). A new value for an existing field still fails: add
 * those as new fields.
 */
export const posPrintersReadSchema = z.preprocess((value) => {
  if (!isRecord(value)) return value;
  const known = pick(value, ['bill']) as Record<string, unknown>;
  if (Object.hasOwn(known, 'bill'))
    known.bill = pick(known.bill, Object.keys(printerSettingsSchema.shape));
  return known;
}, posPrintersSchema);

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
  /** The location's bill printer (`pos.printers`); the app checks the address rules again. */
  printer: printerSettingsSchema,
});
export type NativePrintRequest = z.infer<typeof nativePrintRequestSchema>;

export const nativeDiscoverRequestSchema = z.strictObject({
  version: z.literal(NATIVE_PRINT_PROTOCOL),
  type: z.literal('discover'),
});

/**
 * What an app version can do, named in its `info` answer (version 1.1 on). The web decides by these, never by the
 * version number; an app without `features` (1.0) gets the version 1 behaviour.
 * - `parallel`: prints to different printers at the same time (one lane per printer).
 * - `deviceSettings`: keeps this device's settings (`deviceSettings` / `setDeviceSettings`).
 * - `nothingPrinted`: says when a failed print sent not one byte of the job.
 * - `update`: checks for and installs a newer app version when asked (`update`, `installUpdate`).
 */
export const NATIVE_APP_FEATURES = [
  'parallel',
  'deviceSettings',
  'nothingPrinted',
  'update',
] as const;
export type NativeAppFeature = (typeof NATIVE_APP_FEATURES)[number];

export const nativeInfoAnswerSchema = z.object({
  type: z.literal('info'),
  appVersion: z.string(),
  protocol: z.number().int(),
  /** Unknown names (a later app) are kept and ignored. */
  features: z.array(z.string()).optional(),
});

/** Receipt printers a device remembers, at most one per location. */
export const MAX_DEVICE_RECEIPT_PRINTERS = 50;

/**
 * This device's settings (ADR 0033 §5, §13), kept by the app in its own storage: the web never uses browser
 * storage. Ids are only remembered: the web checks them against the location's printers every time.
 */
export const nativeDeviceSettingsSchema = z.strictObject({
  /** "This device prints": runs print jobs for its location, and keeps the screen on while Durby is in front. */
  prints: z.boolean(),
  /** The location this device prints for; null: the location of the floor page shown last. */
  tillLocationId: z.uuid().nullable(),
  /** The default receipt printer per location (location id → printer id). */
  receiptPrinters: z
    .record(z.uuid(), z.uuid())
    .refine((r) => Object.keys(r).length <= MAX_DEVICE_RECEIPT_PRINTERS),
});
export type NativeDeviceSettings = z.infer<typeof nativeDeviceSettingsSchema>;
export const DEFAULT_DEVICE_SETTINGS: NativeDeviceSettings = {
  prints: true,
  tillLocationId: null,
  receiptPrinters: {},
};

export const nativeDeviceSettingsRequestSchema = z.strictObject({
  version: z.literal(NATIVE_PRINT_PROTOCOL),
  type: z.literal('deviceSettings'),
});

export const nativeSetDeviceSettingsRequestSchema = z.strictObject({
  version: z.literal(NATIVE_PRINT_PROTOCOL),
  type: z.literal('setDeviceSettings'),
  settings: nativeDeviceSettingsSchema,
});

/** The settings as stored, after a read or a write; `refused`: the write broke the schema and stored nothing. */
export const nativeDeviceSettingsAnswerSchema = z.object({
  type: z.literal('deviceSettings'),
  settings: nativeDeviceSettingsSchema,
  refused: z.boolean().optional(),
});
export type NativeInfoAnswer = z.infer<typeof nativeInfoAnswerSchema>;

export const nativePrintAnswerSchema = z.object({
  type: z.literal('print'),
  jobId: z.uuid(),
  state: z.enum(['sent', 'failed']),
  code: z.enum(NATIVE_PRINT_CODES),
  /** `nothingPrinted` feature: the job failed before any of its bytes were sent (safe to send again). */
  nothingPrinted: z.boolean().optional(),
});
export type NativePrintAnswer = z.infer<typeof nativePrintAnswerSchema>;

export const DISCOVERED_PRINTER_STATUSES = [
  'online',
  'paper_out',
  'cover_open',
  'no_status',
] as const;

/** Printers the app found on its own /24 (`discover`). Addresses only, already checked against the rules. */
export const nativeDiscoverAnswerSchema = z.object({
  type: z.literal('discover'),
  /** The scanned network, e.g. `192.168.64.0/24`; null when the device has no private IPv4 address. */
  subnet: z.string().nullable(),
  printers: z.array(
    z.object({
      host: z.string().refine(isAllowedPrinterHost),
      port: z.number().int().refine(isAllowedPrinterPort),
      status: z.enum(DISCOVERED_PRINTER_STATUSES),
    }),
  ),
});
export type NativeDiscoverAnswer = z.infer<typeof nativeDiscoverAnswerSchema>;

/** `{ version: 1, type: 'update' }`: is a newer app on the server (`/downloads/android/latest.json`)? Never installs. */
export const nativeUpdateAnswerSchema = z.object({
  type: z.literal('update'),
  available: z.object({ versionCode: z.number().int(), versionName: z.string() }).nullable(),
});
export type NativeUpdateAnswer = z.infer<typeof nativeUpdateAnswerSchema>;

export const NATIVE_INSTALL_RESULTS = [
  /** Checked; Android's installer now asks the user to confirm. */
  'installing',
  /** Android first needs "allow installing apps from Durby" (its settings screen opened). */
  'needs_permission',
  'update.none',
  'update.download',
  'update.checksum',
  'update.signature',
  'update.invalid',
] as const;

/** `{ version: 1, type: 'installUpdate' }`: download, check and hand over to Android's installer. */
export const nativeInstallUpdateAnswerSchema = z.object({
  type: z.literal('installUpdate'),
  result: z.enum(NATIVE_INSTALL_RESULTS),
});
export type NativeInstallResult = (typeof NATIVE_INSTALL_RESULTS)[number];
