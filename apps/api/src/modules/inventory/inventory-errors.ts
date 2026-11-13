import { HttpStatus } from '@nestjs/common';
import { ApiError } from '../../platform/http';

/** Error codes of the inventory module (docs/modules/inventory.md → Errors). */
export const inventoryErrors = {
  warehouseNotFound: () =>
    new ApiError(HttpStatus.NOT_FOUND, 'inventory.warehouse_not_found', 'Warehouse not found.'),
  locationNotFound: () =>
    new ApiError(HttpStatus.NOT_FOUND, 'inventory.location_not_found', 'Location not found.'),
  itemNotFound: (itemIds: string[] = []) =>
    new ApiError(
      HttpStatus.NOT_FOUND,
      'inventory.item_not_found',
      'Some stock items are unknown or archived.',
      { itemIds },
    ),
  documentNotFound: () =>
    new ApiError(HttpStatus.NOT_FOUND, 'inventory.document_not_found', 'Stock document not found.'),
  warehouseNameTaken: () =>
    new ApiError(
      HttpStatus.CONFLICT,
      'inventory.warehouse_name_taken',
      'This location already has a warehouse with this name.',
    ),
  itemNameTaken: () =>
    new ApiError(
      HttpStatus.CONFLICT,
      'inventory.item_name_taken',
      'A stock item with this name already exists.',
    ),
  insufficientStock: (itemIds: string[]) =>
    new ApiError(
      HttpStatus.CONFLICT,
      'inventory.insufficient_stock',
      'Not enough stock for some items.',
      { itemIds },
    ),
  unitLocked: () =>
    new ApiError(
      HttpStatus.CONFLICT,
      'inventory.unit_locked',
      'The unit cannot change once the item has movements.',
    ),
  valuationUnsupported: () =>
    new ApiError(
      HttpStatus.CONFLICT,
      'inventory.valuation_unsupported',
      'FIFO valuation is not available yet.',
    ),
  productNotFound: () =>
    new ApiError(HttpStatus.NOT_FOUND, 'inventory.product_not_found', 'Product not found.'),
  stationTaken: () =>
    new ApiError(
      HttpStatus.CONFLICT,
      'inventory.station_taken',
      'Another warehouse at this location already supplies this station.',
    ),
  sameWarehouse: () =>
    new ApiError(
      HttpStatus.BAD_REQUEST,
      'inventory.same_warehouse',
      'A transfer needs two different warehouses.',
    ),
  // Step 5 (ADR 0038): units, variants, bills of materials and production.
  unitNotFound: (unitIds: string[] = []) =>
    new ApiError(
      HttpStatus.NOT_FOUND,
      'inventory.unit_not_found',
      'Some units are unknown or archived.',
      { unitIds },
    ),
  unitNameTaken: () =>
    new ApiError(
      HttpStatus.CONFLICT,
      'inventory.unit_name_taken',
      'A unit with this name already exists.',
    ),
  unitMismatch: (itemIds: string[]) =>
    new ApiError(
      HttpStatus.BAD_REQUEST,
      'inventory.unit_mismatch',
      "A unit's base unit must be the item's unit, and the converted quantity must not be zero.",
      { itemIds },
    ),
  attributeNotFound: (attributeIds: string[] = []) =>
    new ApiError(
      HttpStatus.NOT_FOUND,
      'inventory.attribute_not_found',
      'Some variant attributes or values are unknown or archived.',
      { attributeIds },
    ),
  attributeNameTaken: () =>
    new ApiError(
      HttpStatus.CONFLICT,
      'inventory.attribute_name_taken',
      'A variant attribute with this name already exists.',
    ),
  itemHasVariants: (itemIds: string[]) =>
    new ApiError(
      HttpStatus.CONFLICT,
      'inventory.item_has_variants',
      'Items with variants hold no stock themselves: use their variants.',
      { itemIds },
    ),
  variantNotAllowed: () =>
    new ApiError(
      HttpStatus.CONFLICT,
      'inventory.variant_not_allowed',
      'A variant cannot have variants of its own.',
    ),
  tooManyVariants: (max: number) =>
    new ApiError(
      HttpStatus.BAD_REQUEST,
      'inventory.too_many_variants',
      `At most ${max} variants can be generated at once.`,
      { max },
    ),
  bomNotFound: () =>
    new ApiError(
      HttpStatus.NOT_FOUND,
      'inventory.bom_not_found',
      'This item has no bill of materials.',
    ),
  bomInvalid: () =>
    new ApiError(
      HttpStatus.BAD_REQUEST,
      'inventory.bom_invalid',
      'An item cannot be a component of its own bill of materials.',
    ),
};

/** Prisma's unique violation (here: the partial name indexes of the migration). */
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002'
  );
}
