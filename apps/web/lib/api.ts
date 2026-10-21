import { healthResponseSchema, type HealthResponse } from '@durby/shared';

export function apiBaseUrl(): string {
  return process.env.API_URL ?? 'http://localhost:4000';
}

/**
 * Fetches API health. A degraded API answers 503 with a valid body, which is returned as is.
 * Returns null when the API is unreachable or answers unexpectedly.
 */
export async function getHealth(
  fetchImpl: typeof fetch = fetch,
  baseUrl: string = apiBaseUrl(),
): Promise<HealthResponse | null> {
  try {
    const res = await fetchImpl(`${baseUrl}/api/v1/health`, { cache: 'no-store' });
    if (!res.ok && res.status !== 503) return null;
    const parsed = healthResponseSchema.safeParse(await res.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
