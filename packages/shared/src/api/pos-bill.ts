import { z } from 'zod';
import { posPrintersReadSchema } from '../native-print';
import { billFooterSchema, billHeaderSchema } from '../pos-bill-settings';
import { printerSchema } from './pos-printers';

/** `GET /pos/bill-layout?locationId=` (docs/modules/pos.md → Bill layout). */

export const billLayoutQuerySchema = z.object({ locationId: z.uuid() });

/**
 * The effective `pos.billHeader` and `pos.billFooter` at the location, and its printers for the till (ADR 0033):
 * every printer that isn't archived, on or off (a test print may go to one that is still off).
 */
export const billLayoutSchema = z.object({
  header: billHeaderSchema,
  footer: billFooterSchema,
  /**
   * Version 1's bill printer (setting `pos.printers`), read forward-compatibly. Kept for the previous release
   * during a deploy or rollback; this release prints with `printerList`. Removed by the contract step.
   */
  printers: posPrintersReadSchema,
  printerList: z.array(printerSchema),
});

export type BillLayoutQuery = z.infer<typeof billLayoutQuerySchema>;
export type BillLayout = z.infer<typeof billLayoutSchema>;
