import { CustomerPage } from '../../../../../components/staff/customers';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CustomerPage id={id} />;
}
