import { RequestDocument } from '../../../../../components/requests/request-document';

/** A branch request's Order Confirmation (ADR 0064). */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <RequestDocument id={id} kind="oc" />;
}
