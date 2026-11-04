import { PublicMenuPage } from '../../../../components/menu/public-menu-page';

export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <PublicMenuPage link={token} />;
}
