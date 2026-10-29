import { dictionaries, type LabelKey, type Locale, PLACEHOLDER } from './dictionaries';

/** Who stored an override: partners (reviewed migrations) or organizations (the api). */
export type LabelOverrideLevel = 'partner' | 'organization';

/**
 * Override value limits per level (ADR 0011 §4). Lengths count characters (code points), like
 * Postgres `char_length`; the SQL check (1000) is only a shape limit for both tables.
 */
export const LABEL_OVERRIDE_LIMITS = {
  partner: { maxLength: 1000, multiline: true },
  organization: { maxLength: 200, multiline: false },
} as const satisfies Record<LabelOverrideLevel, { maxLength: number; multiline: boolean }>;

/**
 * Keys organizations may override (ADR 0011 §2): terminology only. `*` is one key segment, `**`
 * one or more. Widening this list is a reviewed code change.
 */
export const ORG_OVERRIDABLE = ['*.nav.**', '*.entities.**', '*.fields.**'] as const;

/**
 * Never overridable by organizations, even if ORG_OVERRIDABLE matches: text sent from Durby's
 * address, error messages (security decisions among them), the app's name (white-label is
 * partner-level) and the staff portal.
 */
export const NEVER_ORG_OVERRIDABLE = [
  'platform.email.**',
  'auth.email.**',
  '**.errors.**',
  'platform.app.name',
  // The Durby staff portal (ADR 0017): never rendered for an organization.
  'staff.**',
] as const;

function patternToRegExp(pattern: string): RegExp {
  const segments = pattern
    .split('.')
    .map((s) => (s === '**' ? '[^.]+(?:\\.[^.]+)*' : s === '*' ? '[^.]+' : s));
  return new RegExp(`^${segments.join('\\.')}$`);
}

const ALLOWED = ORG_OVERRIDABLE.map(patternToRegExp);
const DENIED = NEVER_ORG_OVERRIDABLE.map(patternToRegExp);

/** Whether organizations may override `key` (allow-listed and not denied). */
export function isOrgOverridable(key: string): boolean {
  return ALLOWED.some((re) => re.test(key)) && !DENIED.some((re) => re.test(key));
}

/** The set of `{name}` placeholders in `text`, sorted. */
export function placeholdersOf(text: string): string[] {
  return [...new Set([...text.matchAll(PLACEHOLDER)].map((m) => m[1] as string))].sort();
}

export type OverrideProblem =
  | { reason: 'blank' | 'too_long' | 'line_break' | 'control_character' | 'braces' }
  | { reason: 'placeholders'; expected: string[]; found: string[] };

export type OverrideCheck = { ok: true } | ({ ok: false } & OverrideProblem);

// C0 controls except \n, DEL, C1 controls, and bidi embedding/override/isolate characters, which
// can make text read differently from what is stored.
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F‪-‮⁦-⁩]/;
const LINE_BREAK = /[\n\r]/;

/**
 * Checks an override value for `key` in `locale` at `level` (docs/platform/labels.md → Valid
 * override values). Plain text only: it must keep exactly the placeholders of the default text of
 * that key and locale. Whether the level may override the key at all is checked separately
 * (isOrgOverridable).
 */
export function validateOverride(
  key: LabelKey,
  locale: Locale,
  value: string,
  level: LabelOverrideLevel,
): OverrideCheck {
  const limits = LABEL_OVERRIDE_LIMITS[level];
  if (value.trim() === '') return { ok: false, reason: 'blank' };
  if ([...value].length > limits.maxLength) return { ok: false, reason: 'too_long' };
  if (!limits.multiline && LINE_BREAK.test(value)) return { ok: false, reason: 'line_break' };
  if (CONTROL.test(value)) return { ok: false, reason: 'control_character' };
  if (/[{}]/.test(value.replace(PLACEHOLDER, ''))) return { ok: false, reason: 'braces' };
  const expected = placeholdersOf(dictionaries[locale][key]);
  const found = placeholdersOf(value);
  if (expected.join(',') !== found.join(',')) {
    return { ok: false, reason: 'placeholders', expected, found };
  }
  return { ok: true };
}
