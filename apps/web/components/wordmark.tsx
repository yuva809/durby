'use client';

import { cn } from '../lib/utils';
import { useBrand } from './theme-provider';

/**
 * The partner's logo, or (until it has a logo file, ADR 0015 §4) a text wordmark: the product name
 * with a small mark in the primary color. `withName`: the product name beside the logo too (the sidebar).
 */
export function Wordmark({
  className,
  withName = false,
}: {
  className?: string;
  withName?: boolean;
}) {
  const { productName, logoUrl } = useBrand();
  if (logoUrl) {
    // A same-origin static file (LOGO_PATH); <img> never runs an SVG's scripts.
    const logo = (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={logoUrl} alt={productName} className={cn('h-8 w-auto', !withName && className)} />
    );
    if (!withName) return logo;
    return (
      <span
        className={cn('inline-flex min-w-0 items-center gap-2.5', className)}
        data-testid="wordmark-with-name"
      >
        {logo}
        <span aria-hidden className="truncate text-lg font-bold tracking-tight">
          {productName}
        </span>
      </span>
    );
  }
  return (
    <span
      className={cn('inline-flex items-center gap-2 text-lg font-bold tracking-tight', className)}
      data-testid="wordmark"
    >
      <span aria-hidden className="size-3 rounded-sm bg-primary" />
      {productName}
    </span>
  );
}

/** The sign-in pages' logo in the page's top-left corner (none without a logo file). */
export function AuthLogo() {
  const { logoUrl } = useBrand();
  if (!logoUrl) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={logoUrl}
      alt=""
      className="absolute top-4 left-4 h-10 w-auto sm:top-6 sm:left-6 sm:h-12"
      data-testid="auth-logo"
    />
  );
}

/** The sign-in pages' name above the card: the product name with a logo, else the text wordmark. */
export function AuthName() {
  const { productName, logoUrl } = useBrand();
  if (!logoUrl) return <Wordmark className="self-center" />;
  return (
    <p className="self-center text-2xl font-bold tracking-tight" data-testid="auth-product-name">
      {productName}
    </p>
  );
}
