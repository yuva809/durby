import {
  type CountryCode,
  isSupportedCountry,
  parsePhoneNumberFromString,
} from 'libphonenumber-js/min';
import { z } from 'zod';

/**
 * Phone numbers of guests (docs/modules/reservations.md → GDPR): stored in E.164, typed by people
 * as they say them. Shared so the web app can check a number before sending; the api decides.
 */

/**
 * ISO 3166-1 alpha-2 code that phone parsing knows (the platform setting `country`). A plain string
 * schema, so the settings page shows it as a text field; `asCountryCode` narrows a parsed value.
 */
export const countryCodeSchema = z
  .string()
  .regex(/^[A-Z]{2}$/)
  .refine((code) => isSupportedCountry(code), { message: 'Unknown country' });

export const asCountryCode = (code: string): CountryCode => code as CountryCode;

export type { CountryCode };

export type NormalisedPhone = { ok: true; e164: string } | { ok: false };

/**
 * `input` as E.164. Local numbers ("030 1234567", "0176 12345678") are read with `country` (the
 * booking location's); international ones ("+44 …", "0044 …") as they are. Anything that isn't a
 * valid number is refused, never stored as typed.
 */
export function normalisePhone(input: string, country: CountryCode): NormalisedPhone {
  const trimmed = input.trim();
  // Letters are never part of a number here (vanity numbers aren't accepted).
  if (trimmed === '' || /[a-z]/i.test(trimmed)) return { ok: false };
  const international = trimmed.replace(/^00/, '+');
  const phone = parsePhoneNumberFromString(international, country);
  return phone?.isValid() ? { ok: true, e164: phone.number } : { ok: false };
}
