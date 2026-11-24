'use client';

import { useState } from 'react';
import type { SalesHoursResponse } from '@durby/shared';
import { useT } from '../../app/labels-provider';
import type { MoneyFormat } from '../../lib/pos/format';

type Hour = SalesHoursResponse['data'][number];

export const hourLabel = (hour: number) => `${String(hour).padStart(2, '0')}:00`;

/**
 * Sales by hour: one series of columns from one baseline. Each column's whole slot is its hover and focus target; every
 * value is also in the table below. Heights are for drawing only, the amounts stay decimal strings.
 */
export function HourBars({ hours, money }: { hours: readonly Hour[]; money: MoneyFormat }) {
  const t = useT();
  const [shown, setShown] = useState<number | null>(null);
  const top = Math.max(...hours.map((h) => Number(h.gross)), 0);
  const busiest = top > 0 ? hours.find((h) => Number(h.gross) === top) : undefined;
  const readout = hours.find((h) => h.hour === shown) ?? busiest;

  return (
    <figure className="flex flex-col gap-2" data-testid="hour-bars">
      <figcaption className="min-h-6 text-sm" aria-live="polite" data-testid="hour-readout">
        {readout ? (
          <>
            <span className="font-semibold">{money(readout.gross)}</span>{' '}
            <span className="text-muted-foreground">
              {t('reports.hours.readout', {
                hour: hourLabel(readout.hour),
                orders: String(readout.orders),
                items: String(readout.items),
              })}
            </span>
          </>
        ) : null}
      </figcaption>
      <div className="flex h-40 items-end gap-0.5 border-b" onMouseLeave={() => setShown(null)}>
        {hours.map((h) => {
          const height = top > 0 ? Math.max(0, (Number(h.gross) / top) * 100) : 0;
          return (
            <button
              key={h.hour}
              type="button"
              aria-label={`${hourLabel(h.hour)} ${money(h.gross)}`}
              className="group flex h-full min-w-0 flex-1 items-end justify-center"
              onMouseEnter={() => setShown(h.hour)}
              onFocus={() => setShown(h.hour)}
              onBlur={() => setShown(null)}
              data-testid={`hour-${h.hour}`}
            >
              <span
                className="block w-full max-w-6 rounded-t bg-primary group-hover:opacity-80 group-focus-visible:opacity-80"
                style={{ height: `${height}%` }}
              />
            </button>
          );
        })}
      </div>
      <div aria-hidden className="flex gap-0.5 text-xs text-muted-foreground">
        {hours.map((h) => (
          <span key={h.hour} className="min-w-0 flex-1 text-center">
            {h.hour % 6 === 0 ? String(h.hour).padStart(2, '0') : ''}
          </span>
        ))}
      </div>
    </figure>
  );
}
