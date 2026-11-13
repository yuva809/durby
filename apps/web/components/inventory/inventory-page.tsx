'use client';

import type { LabelKey } from '@durby/i18n';
import type { LocationSummary, PermissionKey, StockItem, Warehouse } from '@durby/shared';
import { useState } from 'react';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { loadStockItems, loadWarehouses } from '../../lib/inventory/api';
import { useResource } from '../../lib/use-resource';
import { loadLocations } from '../../lib/users/api';
import { cn } from '../../lib/utils';
import { MoneyProvider } from '../pos/money';
import { Loaded, NoAccess } from '../users/common';
import { DocumentForm } from './document-form';
import { DocumentsTab } from './documents-tab';
import { ItemsTab } from './items-tab';
import { StockTab } from './stock-tab';
import { WarehousesTab } from './warehouses-tab';

export type Tab =
  'stock' | 'receive' | 'adjust' | 'transfer' | 'documents' | 'items' | 'warehouses';

/** Tabs in display order; a tab with a key shows only to holders of it (the api checks again). */
const TABS: readonly { id: Tab; label: LabelKey; permission?: PermissionKey }[] = [
  { id: 'stock', label: 'inventory.tabs.stock' },
  { id: 'receive', label: 'inventory.tabs.receive', permission: 'inventory.stock.receive' },
  { id: 'adjust', label: 'inventory.tabs.adjust', permission: 'inventory.stock.adjust' },
  { id: 'transfer', label: 'inventory.tabs.transfer', permission: 'inventory.stock.transfer' },
  { id: 'documents', label: 'inventory.tabs.documents' },
  { id: 'items', label: 'inventory.tabs.items' },
  { id: 'warehouses', label: 'inventory.tabs.warehouses' },
];

/** What every tab works with: the locations, warehouses and items the caller can see. */
export interface InventoryData {
  locations: LocationSummary[];
  warehouses: Warehouse[];
  items: StockItem[];
  can: (key: PermissionKey) => boolean;
  reload: () => void;
}

/** "Location · Warehouse" when there are several locations, else the warehouse's name. */
export function warehouseLabel(data: InventoryData, warehouse: Warehouse): string {
  if (data.locations.length < 2) return warehouse.name;
  const location = data.locations.find((l) => l.id === warehouse.locationId);
  return location ? `${location.name} · ${warehouse.name}` : warehouse.name;
}

/**
 * /inventory (docs/modules/inventory.md → Web): stock, documents and setup in tabs. `tab` opens another tab first
 * (Inventory → Inventory Adjustment opens Adjust); one the user may not see falls back to Stock.
 */
export function InventoryPage({ tab = 'stock' }: { tab?: Tab }) {
  const { session } = useAuth();
  if (!session) return null;
  if (
    !session.activeFeatures.includes('inventory') ||
    !session.activePermissions.includes('inventory.stock.read')
  ) {
    return <NoAccess title="inventory.nav.title" />;
  }
  return (
    <MoneyProvider>
      <Inventory organizationId={session.activeOrganizationId} initialTab={tab} />
    </MoneyProvider>
  );
}

function Inventory({
  organizationId,
  initialTab,
}: {
  organizationId: string | null;
  initialTab: Tab;
}) {
  const t = useT();
  const { store, session } = useAuth();
  const [tab, setTab] = useState<Tab>(() => {
    const wanted = TABS.find((x) => x.id === initialTab);
    const allowed =
      !wanted?.permission || (session?.activePermissions ?? []).includes(wanted.permission);
    return allowed ? initialTab : 'stock';
  });
  const [locations, reloadLocations] = useResource(organizationId, () => loadLocations(store));
  const [warehouses, reloadWarehouses] = useResource(organizationId, () =>
    loadWarehouses(store, true),
  );
  const [items, reloadItems] = useResource(organizationId, () => loadStockItems(store, true));
  const permissions = new Set(session?.activePermissions ?? []);
  const can = (key: PermissionKey) => permissions.has(key);
  const tabs = TABS.filter((x) => !x.permission || can(x.permission));
  const reload = () => {
    reloadLocations();
    reloadWarehouses();
    reloadItems();
  };

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">{t('inventory.nav.title')}</h1>
      <nav aria-label={t('inventory.tabs.label')} className="-mx-4 border-b sm:-mx-8">
        <ul className="flex gap-1 overflow-x-auto px-4 sm:px-8" role="tablist">
          {tabs.map((x) => (
            <li key={x.id} className="shrink-0">
              <button
                type="button"
                role="tab"
                aria-selected={tab === x.id}
                data-testid={`inventory-tab-${x.id}`}
                onClick={() => setTab(x.id)}
                className={cn(
                  '-mb-px flex min-h-11 items-center border-b-2 px-3 text-sm font-medium whitespace-nowrap',
                  tab === x.id
                    ? 'border-primary text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground',
                )}
              >
                {t(x.label)}
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <Loaded resource={warehouses} reload={reload}>
        {(warehouseList) => (
          <Loaded resource={items} reload={reload}>
            {(itemList) => {
              const data: InventoryData = {
                locations: locations.status === 'ready' ? locations.data : [],
                warehouses: warehouseList,
                items: itemList,
                can,
                reload,
              };
              switch (tab) {
                case 'stock':
                  return <StockTab data={data} />;
                case 'receive':
                case 'adjust':
                case 'transfer':
                  return <DocumentForm key={tab} kind={tab} data={data} />;
                case 'documents':
                  return <DocumentsTab data={data} />;
                case 'items':
                  return <ItemsTab data={data} />;
                case 'warehouses':
                  return <WarehousesTab data={data} />;
              }
            }}
          </Loaded>
        )}
      </Loaded>
    </div>
  );
}
