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
