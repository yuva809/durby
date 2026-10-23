import { z } from 'zod';
import { HEX_COLOR, LOGO_PATH, PRODUCT_NAME_MAX_LENGTH, THEME_TOKEN_NAMES } from '../theme';

const hexColor = z.string().regex(HEX_COLOR);

/**
 * Response body of GET /api/v1/theme (public): the theme of the partner behind the request's host,
 * or the default theme. Carries no partner id and no tenant data (ADR 0015 §3).
 */
export const themeResponseSchema = z.object({
  productName: z.string().min(1).max(PRODUCT_NAME_MAX_LENGTH),
  /** Same-origin path of a static logo file; null = text wordmark. */
  logoUrl: z.string().regex(LOGO_PATH).nullable(),
  tokens: z.strictObject(
    Object.fromEntries(THEME_TOKEN_NAMES.map((name) => [name, hexColor])) as Record<
      (typeof THEME_TOKEN_NAMES)[number],
      typeof hexColor
    >,
  ),
});

export type ThemeResponse = z.infer<typeof themeResponseSchema>;
