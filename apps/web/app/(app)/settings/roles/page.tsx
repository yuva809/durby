import { redirect } from 'next/navigation';

/** Roles moved into Manage Staff, as its Roles tab. */
export default function Page() {
  redirect('/staff');
}
