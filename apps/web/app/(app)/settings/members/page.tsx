import { redirect } from 'next/navigation';

/** Members moved into Manage Staff (docs/platform/rbac.md → Manage Staff). */
export default function Page() {
  redirect('/settings/staff');
}
