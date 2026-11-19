/**
 * Best-before dates (ADR 0062), "2027-03-31" as the api sends them. A warehouse keeps the earliest date of what it
 * holds; the pages show it and mark the past ones.
 */

/** Today as "YYYY-MM-DD", in the viewer's own time zone. */
export function today(now = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

/** Past its date: the day itself still counts as good. */
export const isExpired = (date: string, on: string = today()) => date < on;

/** The earliest of some dates (they compare as text), ignoring nulls; null when there is none. */
export function earliestDate(dates: readonly (string | null)[]): string | null {
  let first: string | null = null;
  for (const date of dates) if (date !== null && (first === null || date < first)) first = date;
  return first;
}
