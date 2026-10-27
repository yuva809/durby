import { OrderPage } from '../../../../../components/pos/order-page';

export default async function Page({ params }: { params: Promise<{ tableId: string }> }) {
  const { tableId } = await params;
  return <OrderPage tableId={tableId} />;
}
