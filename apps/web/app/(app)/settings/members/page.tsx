import { redirect } from 'next/navigation';

/** Members became Manage Staff (docs/platform/rbac.md → Manage Staff). */
export default function Page() {
  redirect('/staff');
}
