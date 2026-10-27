import { z } from 'zod';

/** Request and response bodies of /api/v1/pos/tables (docs/modules/pos.md → Step 1). */

export const TABLE_NAME_MAX_LENGTH = 50;
export const TABLE_AREA_MAX_LENGTH = 50;
export const TABLE_MAX_SEATS = 100;

const tableName = z.string().trim().min(1).max(TABLE_NAME_MAX_LENGTH);
/** Empty means none. */
const area = z.string().trim().max(TABLE_AREA_MAX_LENGTH);
const seats = z.int().min(1).max(TABLE_MAX_SEATS);
const sortOrder = z.int().min(0).max(1_000_000);

export const diningTableSchema = z.object({
  id: z.uuid(),
  locationId: z.uuid(),
  name: z.string(),
  seats: z.int(),
  area: z.string().nullable(),
  sortOrder: z.int(),
  archivedAt: z.iso.datetime().nullable(),
});

export const createDiningTableRequestSchema = z.strictObject({
  locationId: z.uuid(),
  name: tableName,
  seats,
  area: area.optional(),
  sortOrder: sortOrder.optional(),
});

export const updateDiningTableRequestSchema = z
  .strictObject({
    name: tableName.optional(),
    seats: seats.optional(),
    area: area.optional(),
    sortOrder: sortOrder.optional(),
    archived: z.boolean().optional(),
  })
  .refine((body) => Object.values(body).some((v) => v !== undefined), {
    message: 'Nothing to update',
  });

export const listDiningTablesQuerySchema = z.object({
  locationId: z.uuid().optional(),
  includeArchived: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});

export const diningTableListResponseSchema = z.object({ data: z.array(diningTableSchema) });

export type DiningTable = z.infer<typeof diningTableSchema>;
export type CreateDiningTableRequest = z.infer<typeof createDiningTableRequestSchema>;
export type UpdateDiningTableRequest = z.infer<typeof updateDiningTableRequestSchema>;
export type ListDiningTablesQuery = z.infer<typeof listDiningTablesQuerySchema>;
export type DiningTableListResponse = z.infer<typeof diningTableListResponseSchema>;

/** Stable error codes of the pos endpoints; the web app shows the matching label. */
export const POS_ERROR_CODES = [
  'pos.table_not_found',
  'pos.location_not_found',
  'pos.table_name_taken',
] as const;

export type PosErrorCode = (typeof POS_ERROR_CODES)[number];

/** `pos.table_not_found` → `pos.errors.tableNotFound`. */
export function posErrorLabel(code: PosErrorCode): string {
  return `pos.errors.${code.slice('pos.'.length).replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())}`;
}
