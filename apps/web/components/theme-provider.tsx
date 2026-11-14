'use client';

import type { NavLayout, ThemeResponse } from '@durby/shared';
import { createContext, type ReactNode, useContext } from 'react';

/** `navLayout`: the sidebar layout (ADR 0044); absent means `default`. */
export type Brand = Pick<ThemeResponse, 'productName' | 'logoUrl'> & { navLayout?: NavLayout };

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

/** The sidebar layout of the request's partner (ADR 0044); `default` outside a BrandProvider. */
export function useNavLayout(): NavLayout {
  return useContext(BrandContext)?.navLayout ?? 'default';
}
