'use client';

import { useAuth } from './providers';
import { useT } from './labels-provider';

/**
 * Main navigation of the signed-in UI. Items follow the organization's features (a UI hint; the
 * api enforces them) and its terminology. Plain text until the module pages exist.
 */
export function Nav() {
  const { session } = useAuth();
  const t = useT();
  if (!session?.activeFeatures.includes('inventory')) return null;
  return (
    <nav aria-label={t('platform.nav.label')}>
      <ul>
        <li data-testid="nav-inventory">{t('inventory.nav.title')}</li>
      </ul>
    </nav>
  );
}
