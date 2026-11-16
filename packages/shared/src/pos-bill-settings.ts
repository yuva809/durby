import { z } from 'zod';

/**
 * Value shapes of the bill layout settings (docs/modules/pos.md → Bill layout, ADR 0025). The keys
 * themselves are registered in settings.ts. Empty fields are `null` and left out of the print.
 */

/** A small logo inlined as a data URL; the web shrinks and grays it before saving. */
export const BILL_LOGO_MAX_LENGTH = 200_000;
export const BILL_FOOTER_MAX_LINES = 4;
export const BILL_FOOTER_LINE_MAX_LENGTH = 64;

const text = (max: number) => z.string().trim().min(1).max(max).nullable();

export const billLogoSchema = z
  .string()
  .max(BILL_LOGO_MAX_LENGTH)
  .regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/, 'Invalid image');

export const billHeaderSchema = z.strictObject({
  logo: billLogoSchema.nullable(),
  /** Null prints the organization's name. */
  name: text(100),
  phone: text(40),
  email: z.email().max(120).nullable(),
  website: text(120),
});

export const billFooterSchema = z.strictObject({
  /** None prints the `pos.bill.thanks` label. */
  lines: z
    .array(z.string().trim().min(1).max(BILL_FOOTER_LINE_MAX_LENGTH))
    .max(BILL_FOOTER_MAX_LINES),
});

export const DEFAULT_BILL_HEADER: BillHeader = {
  logo: null,
  name: null,
  phone: null,
  email: null,
  website: null,
};

export const DEFAULT_BILL_FOOTER: BillFooter = { lines: [] };

export type BillHeader = z.infer<typeof billHeaderSchema>;
export type BillFooter = z.infer<typeof billFooterSchema>;

/**
 * Text sizes of the printed bill and of kitchen and bar tickets (docs/modules/pos.md → Text size). One overall size,
 * and optionally a size per part; `null` means "as the overall size". Scales the receipt's type, not the paper.
 */
export const PRINT_TEXT_SIZES = ['small', 'normal', 'large', 'xlarge'] as const;
export type PrintTextSize = (typeof PRINT_TEXT_SIZES)[number];

/** How much each size scales the text (normal = as before this setting). */
export const PRINT_TEXT_SCALE: Readonly<Record<PrintTextSize, number>> = {
  small: 0.85,
  normal: 1,
  large: 1.2,
  xlarge: 1.45,
};

const size = z.enum(PRINT_TEXT_SIZES);

export const BILL_TEXT_PARTS = ['header', 'items', 'total', 'footer'] as const;
export type BillTextPart = (typeof BILL_TEXT_PARTS)[number];

export const billTextSchema = z.strictObject({
  size,
  header: size.nullable(),
  items: size.nullable(),
  total: size.nullable(),
  footer: size.nullable(),
});

export const ticketTextSchema = z.strictObject({
  size,
  /** The item lines, what the kitchen reads from a distance. */
  items: size.nullable(),
});

export const DEFAULT_BILL_TEXT: BillText = {
  size: 'normal',
  header: null,
  items: null,
  total: null,
  footer: null,
};
export const DEFAULT_TICKET_TEXT: TicketText = { size: 'normal', items: null };

export type BillText = z.infer<typeof billTextSchema>;
export type TicketText = z.infer<typeof ticketTextSchema>;

/** A part's scale: its own size, else the overall one. */
export function printTextScale<T extends { size: PrintTextSize }>(
  text: T,
  part?: Exclude<keyof T, 'size'>,
): number {
  const own = part === undefined ? null : (text[part] as PrintTextSize | null);
  return PRINT_TEXT_SCALE[own ?? text.size];
}
