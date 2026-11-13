import type { LabelKey } from '@durby/i18n';
import type { FeatureKey, PermissionKey } from '@durby/shared';
import { Package } from 'lucide-react';
import type { NavItem } from './registry';

const page = (
  id: string,
  href: string,
  label: LabelKey,
  permission: PermissionKey,
  feature: FeatureKey = 'inventory',
): NavItem => ({
  id: `inventory-${id}`,
  href,
  label,
  icon: Package,
  group: 'modules',
  permission,
  feature,
});

/**
 * The pages under Inventory in the sidebar, in display order. Products and categories live on the catalog page
 * today; variants, attributes, units, bills of materials and production orders show "coming soon" until they ship.
 */
export const INVENTORY_PAGES: readonly NavItem[] = [
  page('stock', '/inventory', 'inventory.nav.stock', 'inventory.stock.read'),
  page('products', '/catalog', 'inventory.nav.products', 'catalog.products.read', 'catalog'),
  page('variants', '/inventory/variants', 'inventory.nav.variants', 'inventory.stock.read'),
  page('attributes', '/inventory/attributes', 'inventory.nav.attributes', 'inventory.stock.read'),
  page(
    'categories',
    '/catalog#categories',
    'inventory.nav.categories',
    'catalog.products.read',
    'catalog',
  ),
  page('units', '/inventory/units', 'inventory.nav.units', 'inventory.stock.read'),
  page(
    'adjustments',
    '/inventory/adjustments',
    'inventory.nav.adjustments',
    'inventory.stock.adjust',
  ),
  page('bom', '/inventory/bom', 'inventory.nav.bom', 'inventory.stock.read'),
  page('production', '/inventory/production', 'inventory.nav.production', 'inventory.stock.read'),
];
