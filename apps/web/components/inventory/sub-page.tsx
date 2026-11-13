'use client';

import type { LabelKey } from '@durby/i18n';
import type { PermissionKey } from '@durby/shared';
import type { ReactNode } from 'react';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { MoneyProvider } from '../pos/money';
import { NoAccess } from '../users/common';

export interface SubPageContext {
  /** The active organization: a resource key, so lists reload when it changes. */
  organizationId: string | null;
  can: (key: PermissionKey) => boolean;
}

/**
 * The frame of an Inventory sub-page (docs/modules/inventory.md → Step 5): the feature and `inventory.stock.read` (UI
 * hints; the api checks every call), the title and what the page is for.
 */
export function InventorySubPage({
  title,
  description,
  children,
}: {
  title: LabelKey;
  description?: LabelKey;
  children: (ctx: SubPageContext) => ReactNode;
}) {
  const t = useT();
  const { session } = useAuth();
  if (!session) return null;
  const permissions = new Set(session.activePermissions);
  if (!session.activeFeatures.includes('inventory') || !permissions.has('inventory.stock.read')) {
    return <NoAccess title={title} />;
  }
  const ctx: SubPageContext = {
    organizationId: session.activeOrganizationId,
    can: (key) => permissions.has(key),
  };
  return (
    <MoneyProvider>
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold">{t(title)}</h1>
          {description && (
            <p className="max-w-2xl text-sm text-muted-foreground">{t(description)}</p>
          )}
        </div>
        {children(ctx)}
      </div>
    </MoneyProvider>
  );
}
