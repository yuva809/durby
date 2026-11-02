'use client';

import type { TurnTimes, WeeklyHours } from '@durby/shared';
import { Plus, X } from 'lucide-react';
import { useId } from 'react';
import { useT } from '../../app/labels-provider';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { WeeklyHoursEditor } from './hours-editor';

/**
 * Controls of the reservations settings (docs/modules/reservations.md → Settings). They only shape
 * the value; the settings row checks it against the key's schema, like for every other control.
 */

/** `''` while the field is empty (invalid), else the number typed. */
const numberOf = (text: string): number | '' => (text.trim() === '' ? '' : Number(text));

/** A whole number, or `off` ("no limit"). */
export function LimitField({
  value,
  off,
  min,
  max,
  disabled,
  describedBy,
  onChange,
}: {
  value: unknown;
  off: string;
  min: number;
  max: number;
  disabled: boolean;
  describedBy: string;
  onChange: (next: unknown) => void;
}) {
  const t = useT();
  const id = useId();
  const isOff = value === off;
  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="flex min-h-11 items-center gap-2">
        <Checkbox
          id={`${id}-off`}
          checked={isOff}
          disabled={disabled}
          onCheckedChange={(next) => onChange(next === true ? off : min)}
        />
        <Label htmlFor={`${id}-off`} className="text-sm font-normal">
          {t('platform.settingsPage.noLimit')}
        </Label>
      </div>
      {!isOff && (
        <Input
          type="number"
          min={min}
          max={max}
          step={1}
          data-testid="setting-value"
          className="w-28"
          value={typeof value === 'number' ? String(value) : ''}
          disabled={disabled}
          aria-describedby={describedBy}
          onChange={(e) => onChange(numberOf(e.target.value))}
        />
      )}
    </div>
  );
}

/** `inherit` (follow the opening hours), or a weekly schedule of its own that narrows them. */
export function ScheduleOrField({
  value,
  inherit,
  inherited,
  disabled,
  describedBy,
  onChange,
}: {
  value: unknown;
  inherit: string;
  /** The schedule to start from when switching to an own one (the opening hours). */
  inherited: WeeklyHours;
  disabled: boolean;
  describedBy: string;
  onChange: (next: unknown) => void;
}) {
  const t = useT();
  const id = useId();
  const same = value === inherit;
  return (
    <div className="flex w-full flex-col gap-3">
      <div className="flex min-h-11 items-center gap-2">
        <Checkbox
          id={`${id}-same`}
          checked={same}
          disabled={disabled}
          onCheckedChange={(next) => onChange(next === true ? inherit : inherited)}
        />
        <Label htmlFor={`${id}-same`} className="text-sm font-normal">
          {t('platform.settingsPage.sameAsOpeningHours')}
        </Label>
      </div>
      {!same && (
        <WeeklyHoursEditor
          value={value as WeeklyHours}
          disabled={disabled}
          describedBy={describedBy}
          onChange={onChange}
        />
      )}
    </div>
  );
}

/**
 * Party-size bands: each row ends at "up to" (the last at "and more") with its minutes. Rows follow
 * each other: a band starts one after the previous ends, so editing one moves the next.
 */
export function TurnTimesEditor({
  value,
  disabled,
  describedBy,
  onChange,
}: {
  value: TurnTimes;
  disabled: boolean;
  describedBy: string;
  onChange: (next: TurnTimes) => void;
}) {
  const t = useT();
  const set = (bands: TurnTimes) => onChange(contiguous(bands));
  const update = (i: number, patch: Partial<TurnTimes[number]>) =>
    set(value.map((band, j) => (j === i ? { ...band, ...patch } : band)));
  const label = (band: TurnTimes[number]) => {
    const from = String(band.fromParty);
    if (band.toParty === null) return t('platform.settingsPage.turnTimes.andMore', { from });
    if (band.toParty === band.fromParty)
      return t('platform.settingsPage.turnTimes.single', { from });
    return t('platform.settingsPage.turnTimes.band', { from, to: String(band.toParty) });
  };

  return (
    <div className="flex w-full flex-col gap-2" aria-describedby={describedBy}>
      <ul className="flex flex-col gap-2">
        {value.map((band, i) => {
          const last = i === value.length - 1;
          return (
            <li
              key={i}
              data-testid="turn-time"
              data-label={label(band)}
              className="flex flex-wrap items-center gap-2"
            >
              <span className="w-28 shrink-0 text-sm font-medium">{label(band)}</span>
              {!last && (
                <Input
                  type="number"
                  min={band.fromParty}
                  step={1}
                  className="w-20"
                  aria-label={t('platform.settingsPage.turnTimes.upTo')}
                  value={band.toParty === null ? '' : String(band.toParty)}
                  disabled={disabled}
                  onChange={(e) => update(i, { toParty: Number(e.target.value) || 0 })}
                />
              )}
              <Input
                type="number"
                min={1}
                step={1}
                className="w-24"
                aria-label={t('platform.settingsPage.turnTimes.minutes')}
                value={String(band.minutes)}
                disabled={disabled}
                onChange={(e) => update(i, { minutes: Number(e.target.value) || 0 })}
              />
              {!disabled && value.length > 1 && (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t('platform.settingsPage.turnTimes.remove')}
                  onClick={() => set(value.filter((_, j) => j !== i))}
                >
                  <X aria-hidden className="size-4" />
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      {!disabled && value.length < 10 && (
        <Button
          variant="outline"
          className="self-start"
          onClick={() => {
            // Split the open band: its first size becomes a band of its own.
            const open = value[value.length - 1]!;
            set([
              ...value.slice(0, -1),
              { ...open, toParty: open.fromParty },
              { fromParty: open.fromParty + 1, toParty: null, minutes: open.minutes },
            ]);
          }}
        >
          <Plus aria-hidden className="size-4" />
          {t('platform.settingsPage.turnTimes.add')}
        </Button>
      )}
    </div>
  );
}

/** Starts the bands at 1, each one after the previous ends, and opens the last one. */
function contiguous(bands: TurnTimes): TurnTimes {
  let next = 1;
  return bands.map((band, i) => {
    const last = i === bands.length - 1;
    const fixed = { ...band, fromParty: next, toParty: last ? null : band.toParty };
    if (fixed.toParty !== null) next = fixed.toParty + 1;
    return fixed;
  });
}
