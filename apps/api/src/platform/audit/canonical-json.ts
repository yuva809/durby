/**
 * JSON with sorted keys, for comparing stored jsonb values and putting them in snapshots (which hold
 * flat values only); null for null/undefined.
 */
export function canonicalJson(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const sorted = (v: unknown): unknown =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, sorted((v as Record<string, unknown>)[k])]),
        )
      : v;
  return JSON.stringify(sorted(value));
}
