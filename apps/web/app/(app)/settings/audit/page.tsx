import { redirect } from 'next/navigation';

/** The audit log moved out of Settings to /audit; old links (and their filters) keep working. */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    for (const v of [value].flat()) if (v !== undefined) params.append(key, v);
  }
  const query = params.toString();
  redirect(query ? `/audit?${query}` : '/audit');
}
