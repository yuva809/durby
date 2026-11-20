'use client';

import type { LabelKey } from '@durby/i18n';
import type {
  LocationSummary,
  PermissionKey,
  ProductCategory,
  StockItem,
  UnitOfMeasure,
  Warehouse,
} from '@durby/shared';
import { ArrowLeft, FileText, MoreHorizontal, ShoppingCart } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type ReactNode, useState } from 'react';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { loadCategories } from '../../lib/catalog/api';
import { INVENTORY_PAGES } from '../../lib/nav/inventory-pages';
import { visibleNav } from '../../lib/nav/registry';
import {
  loadStockCategories,
  loadStockItems,
  loadUnits,
  loadWarehouses,
} from '../../lib/inventory/api';
import { useResource } from '../../lib/use-resource';
import { loadLocations } from '../../lib/users/api';
import { cn } from '../../lib/utils';
import { MoneyProvider } from '../pos/money';
import { useNavLayout } from '../theme-provider';
import { Button } from '../ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { Loaded, NoAccess } from '../users/common';
import { CategoryOverview } from './category-overview';
import { DocumentForm } from './document-form';
import { DocumentsTab } from './documents-tab';
import { ItemDialog, ItemsTab } from './items-tab';
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
  /** Active units of measurement receipts can be entered in (ADR 0038). */
  units: UnitOfMeasure[];
  /**
   * The organization's categories for filing items (ADR 0048), active and archived: from the catalog, or for stock
   * readers without it from inventory (a branch, ADR 0059); null while they load: then no category field shows.
   */
  categories: ProductCategory[] | null;
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
  const [units] = useResource(organizationId, () => loadUnits(store));
  const catalogReader =
    (session?.activeFeatures.includes('catalog') ?? false) &&
    (session?.activePermissions.includes('catalog.products.read') ?? false);
  // Without the catalog (a branch, ADR 0059) the same categories come from inventory, so stock still shows by them.
  const readsCategories =
    catalogReader || (session?.activePermissions.includes('inventory.stock.read') ?? false);
  const [categories, reloadCategories] = useResource(readsCategories ? organizationId : null, () =>
    catalogReader ? loadCategories(store, true) : loadStockCategories(store, true),
  );
  const permissions = new Set(session?.activePermissions ?? []);
  const can = (key: PermissionKey) => permissions.has(key);
  // A branch asks the main warehouse for goods from here too (ADR 0045, 0053): the request cart.
  const requests =
    (session?.activeFeatures.includes('orders') ?? false) &&
    can('orders.requests.create') &&
    // Branches send requests; those who approve them don't.
    !can('orders.requests.approve');
  const tabs = TABS.filter((x) => !x.permission || can(x.permission));
  const reload = () => {
    reloadLocations();
    reloadWarehouses();
    reloadItems();
    if (readsCategories) reloadCategories();
  };
  // The operations menu (AsiaMight, ADR 0048): one Inventory page opening on category tiles; the other tabs and the
  // setup pages are in its More menu. The default menu keeps the tabs.
  const overview = useNavLayout() === 'operations';

  const withData = (render: (data: InventoryData) => ReactNode) => (
    <Loaded resource={warehouses} reload={reload}>
      {(warehouseList) => (
        <Loaded resource={items} reload={reload}>
          {(itemList) =>
            render({
              locations: locations.status === 'ready' ? locations.data : [],
              warehouses: warehouseList,
              items: itemList,
              units: units.status === 'ready' ? units.data : [],
              categories: readsCategories && categories.status === 'ready' ? categories.data : null,
              can,
              reload,
            })
          }
        </Loaded>
      )}
    </Loaded>
  );

  if (overview) {
    return withData((data) =>
      tab === 'stock' ? (
        <CategoryOverview
          data={data}
          // Who sends requests (a branch) shops the main warehouse's stock per category (ADR 0065).
          branchShop={requests}
          actions={
            <>
              {requests && (
                <Button asChild>
                  <Link href="/requests/new?cart=1" data-testid="inventory-request-stock">
                    <ShoppingCart aria-hidden />
                    {t('inventory.overview.requestStock')}
                  </Link>
                </Button>
              )}
              <MoreMenu tabs={tabs.filter((x) => x.id !== 'stock')} onTab={setTab} />
              {can('inventory.stock.receive') && (
                <Button variant="outline" asChild>
                  <Link href="/inventory/invoice" data-testid="inventory-invoice">
                    <FileText aria-hidden />
                    {t('inventory.invoice.open')}
                  </Link>
                </Button>
              )}
              {can('inventory.items.edit') && (
                <ItemDialog
                  categories={data.categories}
                  warehouses={data.warehouses}
                  locations={data.locations}
                  onDone={data.reload}
                  trigger={t('inventory.overview.addItem')}
                />
              )}
            </>
          }
        />
      ) : (
        <div className="flex flex-col gap-6">
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="ghost" onClick={() => setTab('stock')} data-testid="inventory-back">
              <ArrowLeft aria-hidden />
              {t('inventory.overview.backToInventory')}
            </Button>
            <h1 className="text-2xl font-semibold">
              {t(TABS.find((x) => x.id === tab)?.label ?? 'inventory.nav.title')}
            </h1>
          </div>
          {tabContent(tab, data)}
        </div>
      ),
    );
  }

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
      {withData((data) => tabContent(tab, data))}
    </div>
  );
}

function tabContent(tab: Tab, data: InventoryData): ReactNode {
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
}

/**
 * More (operations menu): the other tabs (receive, adjust, transfer, history, items, warehouses) and the inventory
 * setup pages the person may open (variants, attributes, units, adjustments, bills of materials, production).
 */
function MoreMenu({
  tabs,
  onTab,
}: {
  tabs: readonly { id: Tab; label: LabelKey }[];
  onTab: (tab: Tab) => void;
}) {
  const t = useT();
  const router = useRouter();
  const { session } = useAuth();
  const pages = session
    ? visibleNav(
        INVENTORY_PAGES.filter((page) => SETUP_PAGES.includes(page.id.replace('inventory-', ''))),
        { activeFeatures: session.activeFeatures, activePermissions: session.activePermissions },
      )
    : [];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" data-testid="inventory-more">
          <MoreHorizontal aria-hidden />
          {t('inventory.overview.more')}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        {tabs.map((x) => (
          <DropdownMenuItem
            key={x.id}
            onSelect={() => onTab(x.id)}
            data-testid={`inventory-more-${x.id}`}
          >
            {t(x.label)}
          </DropdownMenuItem>
        ))}
        {pages.length > 0 && <DropdownMenuSeparator />}
        {pages.map((page) => (
          <DropdownMenuItem
            key={page.id}
            onSelect={() => router.push(page.href)}
            data-testid={`inventory-more-${page.id}`}
          >
            {t(page.label)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Setup pages in More: everything of the old submenu but Stock (this page), Products and Categories (own items). */
const SETUP_PAGES = ['variants', 'attributes', 'units', 'adjustments', 'bom', 'production'];
