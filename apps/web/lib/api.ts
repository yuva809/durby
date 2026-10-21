import { healthResponseSchema, type HealthResponse } from '@durby/shared';

export function apiBaseUrl(): string {
  return process.env.API_URL ?? 'http://localhost:4000';
}

/** Fetches API health; returns null when the API is unreachable or answers unexpectedly. */
export async function getHealth(
  fetchImpl: typeof fetch = fetch,
  baseUrl: string = apiBaseUrl(),
): Promise<HealthResponse | null> {
  try {
    const res = await fetchImpl(`${baseUrl}/api/v1/health`, { cache: 'no-store' });
    if (!res.ok) return null;
    const parsed = healthResponseSchema.safeParse(await res.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
