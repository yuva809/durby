import { z } from 'zod';
import { billFooterSchema, billHeaderSchema } from '../pos-bill-settings';

/** `GET /pos/bill-layout?locationId=` (docs/modules/pos.md → Bill layout). */

export const billLayoutQuerySchema = z.object({ locationId: z.uuid() });

/** The effective `pos.billHeader` and `pos.billFooter` at the location. */
export const billLayoutSchema = z.object({
  header: billHeaderSchema,
  footer: billFooterSchema,
});

export type BillLayoutQuery = z.infer<typeof billLayoutQuerySchema>;
export type BillLayout = z.infer<typeof billLayoutSchema>;
