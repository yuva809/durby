import { z } from 'zod';

/**
 * Value shapes of the reservations settings (docs/modules/reservations.md → Settings). The keys
 * themselves are registered in settings.ts.
 */

/** Largest party the registry deals with (`reservations.party_size_out_of_range` above it). */
export const MAX_PARTY_SIZE = 100;

/** Booking slots start every 15, 30 or 60 minutes. */
export const SLOT_INTERVALS = [15, 30, 60] as const;

const MAX_TURN_MINUTES = 720;

const turnTimeBandSchema = z.strictObject({
  fromParty: z.int().min(1).max(MAX_PARTY_SIZE),
  /** Last party size of the band; null = "and more" (the last band only). */
  toParty: z.int().min(1).max(MAX_PARTY_SIZE).nullable(),
  minutes: z.int().min(1).max(MAX_TURN_MINUTES),
});

/**
 * How long a table is booked, by party size: bands sorted by size, contiguous from 1, the last one
 * open-ended, so every party size has exactly one turn time.
 */
export const turnTimesSchema = z
  .array(turnTimeBandSchema)
  .min(1)
  .max(10)
  .refine((bands) => bandProblems(bands) === null, {
    message: 'Bands must start at 1, follow each other without gaps or overlaps, and end open',
  });

export type TurnTimes = z.infer<typeof turnTimesSchema>;

export const DEFAULT_TURN_TIMES: TurnTimes = [
  { fromParty: 1, toParty: 2, minutes: 90 },
  { fromParty: 3, toParty: 4, minutes: 120 },
  { fromParty: 5, toParty: null, minutes: 150 },
];

/** The turn time of a party of `partySize` (bands are valid, so one always matches). */
export function turnTimeFor(partySize: number, bands: TurnTimes): number {
  const band = bands.find((b) => partySize >= b.fromParty && (b.toParty ?? Infinity) >= partySize);
  return (band ?? bands[bands.length - 1]!).minutes;
}

function bandProblems(
  bands: readonly { fromParty: number; toParty: number | null }[],
): string | null {
  let next = 1;
  for (const [i, band] of bands.entries()) {
    const last = i === bands.length - 1;
    if (band.fromParty !== next) return 'gap, overlap or wrong order';
    if (band.toParty === null) return last ? null : 'open band before the last';
    if (band.toParty < band.fromParty) return 'empty band';
    next = band.toParty + 1;
  }
  return 'last band must be open';
}
