'use client';

import { LocationsPage } from '../settings/locations-page';
import { useNavLayout } from '../theme-provider';
import { BranchesPage } from './branches-page';

/**
 * /branches: the Branches page (ADR 0056) where the partner's brand uses the operations menu (AsiaMight); elsewhere the
 * plain locations list under the Branches title, as before.
 */
export function BranchesRoute() {
  return useNavLayout() === 'operations' ? (
    <BranchesPage />
  ) : (
    <LocationsPage title="platform.nav.branches" />
  );
}
