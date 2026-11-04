import { z } from 'zod';
import { CURRENCY_CODES } from '../currencies';

/** The public table menu (docs/modules/pos.md → QR menu, ADR 0026). No ids, VAT or staff data. */

/** `<organizationId>.<menuToken>`: 24 URL-safe characters after the dot. */
export const MENU_TOKEN_LENGTH = 24;
export const menuTokenParamSchema = z
  .string()
  .regex(/^[0-9a-fA-F-]{36}\.[A-Za-z0-9_-]{24}$/, 'Invalid menu link');

export const publicMenuSchema = z.object({
  /** The bill header's name, else the organization's. */
  name: z.string(),
  logo: z.string().nullable(),
  tableName: z.string(),
  currency: z.enum(CURRENCY_CODES),
  locale: z.string(),
  categories: z.array(
    z.object({
      name: z.string(),
      products: z.array(
        z.object({
          name: z.string(),
          description: z.string().nullable(),
          /** Gross, two decimals. */
          price: z.string(),
        }),
      ),
    }),
  ),
});

export type PublicMenu = z.infer<typeof publicMenuSchema>;
