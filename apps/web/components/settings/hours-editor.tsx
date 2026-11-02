'use client';

import { type HoursWindow, WEEKDAYS, type WeeklyHours } from '@durby/shared';
import { Plus, X } from 'lucide-react';
import { useId, useState } from 'react';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { Button } from '../ui/button';
import { Input } from '../ui/input';

/** At most this many windows per day (`weeklyHoursSchema`). */
const MAX_WINDOWS = 4;

/** `HH:mm` one hour after `time`, wrapping at midnight. */
const hourAfter = (time: string) =>
  `${String((Number(time.slice(0, 2)) + 1) % 24).padStart(2, '0')}${time.slice(2)}`;

/**
 * The weekly windows of `openingHours` (docs/modules/reservations.md → Settings): per weekday a list
 * of opens/closes times; a window that closes before it opens runs past midnight. The schema check
 * (overlaps, empty windows) runs in the settings row, like for every other control.
 */
export function WeeklyHoursEditor({
  value,
  disabled,
  describedBy,
  onChange,
}: {
  value: WeeklyHours;
  disabled: boolean;
  describedBy: string;
  onChange: (next: WeeklyHours) => void;
}) {
  const t = useT();
  const setDay = (day: keyof WeeklyHours, windows: HoursWindow[]) =>
    onChange({ ...value, [day]: windows });

  return (
    // A container: the "add window" text shows only where the editor itself is wide enough
    // (a German label wrapped onto its own line on a tablet).
    <ul className="@container flex w-full flex-col gap-2" aria-describedby={describedBy}>
      {WEEKDAYS.map((day) => {
        const windows = value[day];
        const last = windows.at(-1);
        return (
          <li
            key={day}
            data-testid={`hours-day-${day}`}
            className="flex flex-wrap items-center gap-2 sm:flex-nowrap"
          >
            <span className="w-28 shrink-0 text-sm font-medium">
              {t(`platform.settingsPage.weekdays.${day}`)}
            </span>
            <div className="flex flex-wrap items-center gap-2">
              {windows.length === 0 && (
                <span className="text-sm text-muted-foreground">
                  {t('platform.settingsPage.closed')}
                </span>
              )}
              {windows.map((w, i) => {
                const update = (patch: Partial<HoursWindow>) =>
                  setDay(
                    day,
                    windows.map((x, j) => (j === i ? { ...x, ...patch } : x)),
                  );
                return (
                  <span key={i} className="flex items-center gap-1">
                    <Input
                      type="time"
                      className="w-28"
                      aria-label={t('platform.settingsPage.opens')}
                      value={w.from}
                      disabled={disabled}
                      onChange={(e) => update({ from: e.target.value })}
                    />
                    <span aria-hidden>–</span>
                    <Input
                      type="time"
                      className="w-28"
                      aria-label={t('platform.settingsPage.closes')}
                      value={w.to}
                      disabled={disabled}
                      onChange={(e) => update({ to: e.target.value })}
                    />
                    {!disabled && (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={t('platform.settingsPage.removeWindow')}
                        onClick={() =>
                          setDay(
                            day,
                            windows.filter((_, j) => j !== i),
                          )
                        }
                      >
                        <X aria-hidden className="size-4" />
                      </Button>
                    )}
                  </span>
                );
              })}
              {!disabled && windows.length < MAX_WINDOWS && (
                <Button
                  variant="outline"
                  aria-label={t('platform.settingsPage.addWindow')}
                  title={t('platform.settingsPage.addWindow')}
                  className="px-3 @2xl:px-4"
                  onClick={() => {
                    // Starts where the last window ends, so it never overlaps by default.
                    const from = last?.to ?? '12:00';
                    setDay(day, [...windows, { from, to: hourAfter(from) }]);
                  }}
                >
                  <Plus aria-hidden className="size-4" />
                  <span className="hidden @2xl:inline">{t('platform.settingsPage.addWindow')}</span>
                </Button>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** The days of `closedDates`, sorted, with a date field to add one. */
export function DateListEditor({
  value,
  disabled,
  describedBy,
  onChange,
}: {
  value: readonly string[];
  disabled: boolean;
  describedBy: string;
  onChange: (next: string[]) => void;
}) {
  const t = useT();
  const { session } = useAuth();
  const id = useId();
  const [pending, setPending] = useState('');
  const sorted = [...value].sort();
  // A calendar day, not an instant: read at UTC midnight and shown in UTC, so no zone shifts it.
  const dayFormat = new Intl.DateTimeFormat(session?.user.locale, {
    dateStyle: 'medium',
    timeZone: 'UTC',
  });
  const shown = (date: string) => dayFormat.format(new Date(`${date}T00:00:00Z`));

  return (
    <div className="flex w-full flex-col gap-2" aria-describedby={describedBy}>
      {sorted.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('platform.settingsPage.noClosedDates')}</p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {sorted.map((date) => (
            <li
              key={date}
              data-testid="closed-date"
              data-date={date}
              className="flex items-center gap-1 rounded-md border px-2 py-1 text-sm"
            >
              {shown(date)}
              {!disabled && (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t('platform.settingsPage.removeDate', { date: shown(date) })}
                  onClick={() => onChange(sorted.filter((d) => d !== date))}
                >
                  <X aria-hidden className="size-3" />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!disabled && (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            id={`${id}-date`}
            type="date"
            className="w-44"
            aria-label={t('platform.settingsPage.dateToAdd')}
            value={pending}
            onChange={(e) => setPending(e.target.value)}
          />
          <Button
            variant="outline"

            disabled={pending === '' || value.includes(pending)}
            onClick={() => {
              onChange([...value, pending].sort());
              setPending('');
            }}
          >
            <Plus aria-hidden className="size-4" />
            {t('platform.settingsPage.addDate')}
          </Button>
        </div>
      )}
    </div>
  );
}
