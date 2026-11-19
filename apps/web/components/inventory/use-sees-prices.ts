'use client';

import { useAuth } from '../../app/providers';

/**
 * Whether the signed-in person sees prices and values in inventory (ADR 0060). Without inventory.prices.read the api
 * leaves them out (null), and the pages leave out their columns, totals and export columns: a branch sees items and
 * quantities only.
 */
export function useSeesPrices(): boolean {
  const { session } = useAuth();
  return session?.activePermissions.includes('inventory.prices.read') ?? false;
}
