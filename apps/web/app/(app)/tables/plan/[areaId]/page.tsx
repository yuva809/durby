import { DesignerPage } from '../../../../../components/tables/plan/designer-page';

export default async function Page({ params }: { params: Promise<{ areaId: string }> }) {
  const { areaId } = await params;
  return <DesignerPage areaId={areaId} />;
}
