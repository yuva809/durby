'use client';

import { useT } from '../../app/labels-provider';
import { Select } from '../ui/select';
import type { InventoryData } from './inventory-page';

/**
 * The location filter of the inventory tabs: a warehouse, a branch (its own warehouse), or all locations. The value is
 * "w:<warehouse>", "l:<branch>" or "" (all).
 */
export function LocationFilter({
  id,
  value,
  data,
  onChange,
  testId,
  className,
}: {
  id: string;
  value: string;
  data: InventoryData;
  onChange: (value: string) => void;
  testId: string;
  className?: string;
}) {
  const t = useT();
  return (
    <Select
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={className ?? 'w-auto'}
      aria-label={t('inventory.page.filterLocation')}
      data-testid={testId}
    >
      <optgroup label={t('inventory.page.groupWarehouses')}>
        {data.warehouses
          .filter((w) => w.archivedAt === null)
          .map((w) => (
            <option key={w.id} value={`w:${w.id}`}>
              {w.isMain ? `${w.name} (${t('inventory.page.mainWarehouse')})` : w.name}
            </option>
          ))}
      </optgroup>
      <option value="">{t('inventory.page.allWarehouses')}</option>
    </Select>
  );
}

/** The stock query for a filter value (the same values as LocationFilter). */
export function stockQueryOf(value: string): { locationId?: string; warehouseId?: string } {
  if (value.startsWith('w:')) return { warehouseId: value.slice(2) };
  if (value.startsWith('l:')) return { locationId: value.slice(2) };
  return {};
}
