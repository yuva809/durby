import { HttpStatus } from '@nestjs/common';
import type { ImportRowProblem } from '@durby/shared';
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
