'use client';

import type { Reservation } from '@durby/shared';
import { Users } from 'lucide-react';
import { useState } from 'react';
import { Notice } from '../../app/auth-layout';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { type ApiErrorCode, errorLabel } from '../../lib/auth/errors';
import { clockTime, decide, openDecisions } from '../../lib/reservations/host';
import { useActionKey } from '../../lib/use-action-key';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { ConfirmAction } from '../users/common';

/**
 * Online bookings waiting for the restaurant (docs/modules/reservations.md → Requests and pending bookings, R2.3b): a
 * larger party's request (Accept, with the engine's tables or chosen ones) and bookings to confirm (auto-confirm off).
 * Oldest first, with their age.
 */
export function RequestsPanel({
  bookings,
  timeZone,
  now,
  canManage,
  onDone,
  onChooseTables,
}: {
  bookings: readonly Reservation[];
  timeZone: string;
  now: number;
  canManage: boolean;
  onDone: (booking: Reservation) => void;
  /** The engine's tables were taken: let the host choose. */
  onChooseTables: (booking: Reservation) => void;
}) {
  const t = useT();
  const open = openDecisions(bookings);
  if (open.length === 0) return null;
  return (
    <section
      className="flex flex-col gap-2 rounded-lg border border-primary/40 bg-card p-3"
      aria-label={t('reservations.host.requests.title')}
      data-testid="requests-panel"
    >
      <h2 className="text-lg font-semibold">
        {t('reservations.host.requests.title')}
        <span className="ml-2 text-muted-foreground tabular-nums">{open.length}</span>
      </h2>
      <ul className="flex flex-col gap-2">
        {open.map((booking) => (
          <RequestRow
            key={booking.id}
            booking={booking}
            timeZone={timeZone}
            now={now}
            canManage={canManage}
            onDone={onDone}
            onChooseTables={onChooseTables}
          />
        ))}
      </ul>
    </section>
  );
}

function RequestRow({
  booking,
  timeZone,
  now,
  canManage,
  onDone,
  onChooseTables,
}: {
  booking: Reservation;
  timeZone: string;
  now: number;
  canManage: boolean;
  onDone: (booking: Reservation) => void;
  onChooseTables: (booking: Reservation) => void;
}) {
  const t = useT();
  const { store } = useAuth();
  const action = useActionKey();
  const declineAction = useActionKey();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ApiErrorCode | 'unknown' | null>(null);
  const guest = booking.guest.name ?? t('reservations.host.noName');
  const minutes = Math.max(0, Math.floor((now - Date.parse(booking.createdAt)) / 60_000));
  const age =
    minutes < 120
      ? t('reservations.host.requests.age', { minutes: String(minutes) })
      : t('reservations.host.requests.ageHours', { hours: String(Math.floor(minutes / 60)) });
  const requested = booking.status === 'requested';

  async function answer() {
    setBusy(true);
    setFailure(null);
    const result = await decide(store, action, booking.id, requested ? 'accept' : 'confirm');
    setBusy(false);
    if (result.ok && result.data) return onDone(result.data);
    const code = result.ok ? 'unknown' : result.code;
    // The engine's tables are gone: the host picks others.
    if (
      requested &&
      (code === 'reservations.table_unavailable' || code === 'reservations.table_occupied')
    ) {
      return onChooseTables(booking);
    }
    setFailure(code);
  }

  return (
    <li
      className="flex flex-col gap-2 rounded-md border border-border p-3"
      data-testid="request-row"
      data-guest={booking.guest.name ?? ''}
      data-status={booking.status}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-lg font-semibold tabular-nums">
            {clockTime(booking.startsAt, timeZone)}
          </span>
          <span className="font-medium">{guest}</span>
          <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
            <Users aria-hidden className="size-3.5" />
            {t('reservations.host.partyOf', { count: String(booking.partySize) })}
          </span>
        </span>
        <span className="flex items-center gap-2">
          <Badge>
            {t(requested ? 'reservations.status.requested' : 'reservations.status.pending')}
          </Badge>
          <span className="text-sm text-muted-foreground" data-testid="request-age">
            {age}
          </span>
        </span>
      </div>
      {requested && (
        <p className="text-sm text-muted-foreground">{t('reservations.host.requests.noTable')}</p>
      )}
      {booking.guestNote && <p className="text-sm break-words">{booking.guestNote}</p>}
      <Notice text={failure ? t(errorLabel(failure)) : null} tone="error" />
      {canManage && (
        <div className="flex flex-wrap gap-2">
          <Button disabled={busy} onClick={() => void answer()} data-testid="request-answer">
            {t(
              requested ? 'reservations.host.actions.accept' : 'reservations.host.actions.confirm',
            )}
          </Button>
          <ConfirmAction
            trigger={t('reservations.host.actions.decline')}
            title={t('reservations.host.confirmDecline.title', { guest })}
            description={t('reservations.host.confirmDecline.description')}
            confirm={t('reservations.host.actions.decline')}
            testId="request-decline"
            run={async () => {
              const result = await decide(store, declineAction, booking.id, 'decline');
              if (result.ok && result.data) onDone(result.data);
              return result;
            }}
            onDone={() => undefined}
          />
        </div>
      )}
    </li>
  );
}
