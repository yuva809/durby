import { HttpStatus } from '@nestjs/common';
import type { ImportRowProblem, PriceRuleProblem } from '@durby/shared';
import { ApiError } from '../../platform/http';

/** Error codes of the catalog module (docs/modules/catalog.md → Errors). */
export const catalogErrors = {
  categoryNotFound: () =>
    new ApiError(HttpStatus.NOT_FOUND, 'catalog.category_not_found', 'Category not found.'),
  productNotFound: () =>
    new ApiError(HttpStatus.NOT_FOUND, 'catalog.product_not_found', 'Product not found.'),
  categoryNameTaken: () =>
    new ApiError(
      HttpStatus.CONFLICT,
      'catalog.category_name_taken',
      'A category with this name already exists.',
    ),
  productNameTaken: () =>
    new ApiError(
      HttpStatus.CONFLICT,
      'catalog.product_name_taken',
      'This category already has a product with this name.',
    ),
  /** Bulk actions: the ids that don't exist in this organization. */
  productsNotFound: (ids: string[]) =>
    new ApiError(HttpStatus.NOT_FOUND, 'catalog.product_not_found', 'Product not found.', { ids }),
  categoriesNotFound: (ids: string[]) =>
    new ApiError(HttpStatus.NOT_FOUND, 'catalog.category_not_found', 'Category not found.', {
      ids,
    }),
  /** A bulk price change would leave these products below 0 or beyond the price column. */
  priceInvalid: (ids: string[]) =>
    new ApiError(
      HttpStatus.BAD_REQUEST,
      'catalog.price_invalid',
      'The price change would make some prices invalid.',
      { ids },
    ),
  priceRuleNotFound: () =>
    new ApiError(HttpStatus.NOT_FOUND, 'catalog.price_rule_not_found', 'Price rule not found.'),
  priceRuleInvalid: (problems: PriceRuleProblem[]) =>
    new ApiError(
      HttpStatus.BAD_REQUEST,
      'catalog.price_rule_invalid',
      'The price rule is invalid.',
      {
        problems,
      },
    ),
  locationNotFound: () =>
    new ApiError(HttpStatus.NOT_FOUND, 'catalog.location_not_found', 'Location not found.'),
  menuNumberTaken: () =>
    new ApiError(
      HttpStatus.CONFLICT,
      'catalog.menu_number_taken',
      'Another product already has this menu number.',
    ),
  categoryArchived: () =>
    new ApiError(HttpStatus.CONFLICT, 'catalog.category_archived', 'The category is archived.'),
  importInvalid: (rows: ImportRowProblem[]) =>
    new ApiError(
      HttpStatus.BAD_REQUEST,
      'catalog.import_invalid',
      'Some import rows are invalid.',
      {
        rows,
      },
    ),
};

/** Prisma's unique violation (here: the partial name indexes of the migration). */
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002'
  );
}

/** The violated index or constraint names `column` (Prisma puts it in the meta or the message). */
export function violates(error: unknown, column: string): boolean {
  const { meta, message } = error as { meta?: unknown; message?: unknown };
  const text = `${JSON.stringify(meta ?? {})} ${typeof message === 'string' ? message : ''}`;
  return text.includes(column);
}

/**
 * The database refused a delete because a row still refers to it (an order line to a sold product,
 * ON DELETE RESTRICT). Prisma reports it as P2003 (or P2014 for a required relation); the raw
 * Postgres code is 23503.
 */
export function isForeignKeyViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return (
    code === 'P2003' ||
    code === 'P2014' ||
    code === '23503' ||
    (typeof message === 'string' && /foreign key|23503/i.test(message))
  );
}
