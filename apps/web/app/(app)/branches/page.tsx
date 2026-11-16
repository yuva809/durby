import { LocationsPage } from '../../../components/settings/locations-page';

/** Branches in the operations menu (ADR 0044): Settings → Locations under its own name. */
export default function Page() {
  return <LocationsPage title="platform.nav.branches" />;
}
