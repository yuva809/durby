'use client';

import { useMemo } from 'react';
import { useT } from '../../app/labels-provider';
import { isExpired } from '../../lib/inventory/expiry';
import { cn } from '../../lib/utils';

/**
 * A best-before date as the pages show it (ADR 0062): in the viewer's date format, red and said to be expired when it
 * is past; a dash when there is none.
 */
export function ExpiryDate({ value, testId }: { value: string | null; testId?: string }) {
  const t = useT();
  // The date is a calendar day: formatted in UTC, it never shifts by the viewer's time zone.
  const format = useMemo(
    () => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' }),
    [],
  );
  if (!value) {
    return (
      <span className="text-muted-foreground" data-testid={testId}>
        –
      </span>
    );
  }
  const expired = isExpired(value);
  return (
    <span
      className={cn('tabular-nums', expired && 'font-medium text-destructive')}
      title={expired ? t('inventory.expiry.expired') : undefined}
      data-testid={testId}
      data-expired={expired || undefined}
    >
      {format.format(new Date(`${value}T00:00:00Z`))}
      {expired && <span className="sr-only">{` (${t('inventory.expiry.expired')})`}</span>}
    </span>
  );
}
