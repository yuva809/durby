import { z } from 'zod';
import { PREP_STATIONS } from './catalog';
import { KITCHEN_TICKET_KINDS, TICKET_STATUSES } from './pos-orders';

/** The kitchen and bar screens (docs/modules/pos.md → Kitchen and bar screens, ADR 0026). */

export const stationParamSchema = z.enum(PREP_STATIONS);

export const stationBoardQuerySchema = z.object({ locationId: z.uuid() });

/** Statuses a request may set; `new` is only the absence of a change. */
export const SETTABLE_TICKET_STATUSES = ['preparing', 'ready', 'served'] as const;

export const ticketStatusRequestSchema = z.strictObject({
  status: z.enum(SETTABLE_TICKET_STATUSES),
});

export const stationTicketSchema = z.object({
  id: z.uuid(),
  orderId: z.uuid(),
  orderNumber: z.string(),
  tableName: z.string(),
  sequence: z.int(),
  kind: z.enum(KITCHEN_TICKET_KINDS),
  status: z.enum(TICKET_STATUSES),
  createdAt: z.iso.datetime(),
  /** When the status last changed; `createdAt` while new. */
  statusAt: z.iso.datetime(),
  lines: z.array(
    z.object({
      id: z.uuid(),
      productName: z.string(),
      /** Negative on a void ticket. */
      quantity: z.int(),
      note: z.string().nullable(),
    }),
  ),
});

export const stationBoardResponseSchema = z.object({ data: z.array(stationTicketSchema) });

export type SettableTicketStatus = (typeof SETTABLE_TICKET_STATUSES)[number];
export type StationBoardQuery = z.infer<typeof stationBoardQuerySchema>;
export type TicketStatusRequest = z.infer<typeof ticketStatusRequestSchema>;
export type StationTicket = z.infer<typeof stationTicketSchema>;
export type StationBoardResponse = z.infer<typeof stationBoardResponseSchema>;
