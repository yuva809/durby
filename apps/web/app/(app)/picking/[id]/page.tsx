import { RequestPicking } from '../../../../components/requests/request-picking';

/** One transfer being picked and packed by the warehouse (ADR 0045, item 9). */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <RequestPicking requestId={id} />;
}
