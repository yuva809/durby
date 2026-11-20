import { InventoryPage } from '../../../../components/inventory/inventory-page';

/** The items, opened from the top bar's search (ADR 0046): ?q= fills the search. */
export default function Page() {
  return <InventoryPage tab="items" />;
}
