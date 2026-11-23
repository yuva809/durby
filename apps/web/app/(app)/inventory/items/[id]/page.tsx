import { ItemActivityPage } from '../../../../../components/inventory/item-activity';

/** One stock item: its details, Edit with its stock quantity, and its activity ledger. */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ItemActivityPage itemId={id} />;
}
