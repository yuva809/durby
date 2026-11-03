import { redirect } from 'next/navigation';

/** Manage Staff has its own menu item (docs/platform/rbac.md → Manage Staff). */
export default function Page() {
  redirect('/staff');
}
