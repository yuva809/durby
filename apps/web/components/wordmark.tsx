'use client';

import { cn } from '../lib/utils';
import { useBrand } from './theme-provider';

/**
 * The partner's logo, or (until it has a logo file, ADR 0015 §4) a text wordmark: the product name
 * with a small mark in the primary color.
 */
export function Wordmark({ className }: { className?: string }) {
  const { productName, logoUrl } = useBrand();
  if (logoUrl) {
    // A same-origin static file (LOGO_PATH); <img> never runs an SVG's scripts.
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={logoUrl} alt={productName} className={cn('h-8 w-auto', className)} />;
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
