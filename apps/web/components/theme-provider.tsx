'use client';

import type { ThemeResponse } from '@durby/shared';
import { createContext, type ReactNode, useContext } from 'react';

export type Brand = Pick<ThemeResponse, 'productName' | 'logoUrl'>;

const BrandContext = createContext<Brand | null>(null);

/**
 * The request's partner brand (product name, logo) for client components. Colors need no context:
 * the root layout writes them as CSS variables.
 */
export function BrandProvider({ brand, children }: { brand: Brand; children: ReactNode }) {
  return <BrandContext value={brand}>{children}</BrandContext>;
}

export function useBrand(): Brand {
  const brand = useContext(BrandContext);
  if (!brand) throw new Error('useBrand needs <BrandProvider>');
  return brand;
}
