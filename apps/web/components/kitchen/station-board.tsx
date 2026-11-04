'use client';

import type { LabelKey } from '@durby/i18n';
import type {
  LocationSummary,
  PermissionKey,
  PrepStation,
  SettableTicketStatus,
  StationTicket,
  TicketStatus,
} from '@durby/shared';
import { Undo2 } from 'lucide-react';
import { useCallback, useId, useState } from 'react';
import { Notice } from '../../app/auth-layout';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { errorLabel } from '../../lib/auth/errors';
import { loadStationBoard, moveTicket } from '../../lib/pos/api';
import { useNow } from '../../lib/pos/use-now';
import { useActionKey } from '../../lib/use-action-key';
import { useResource } from '../../lib/use-resource';
import { loadLocations } from '../../lib/users/api';
import { cn } from '../../lib/utils';
import { NoLocations } from '../settings/locations-page';
import { Button } from '../ui/button';
import { Label } from '../ui/label';
import { Select } from '../ui/select';
import { Loaded, NoAccess } from '../users/common';

const STATION_KEYS: Record<PrepStation, PermissionKey> = {
  kitchen: 'pos.kitchen.use',
  bar: 'pos.bar.use',
};

/** The board's columns; served tickets stay in Ready for a moment, with undo. */
const COLUMNS = ['new', 'preparing', 'ready'] as const;

/** Minutes after which a ticket's age turns amber, then red. */
const LATE_MINUTES = 10;
const VERY_LATE_MINUTES = 20;

/** The next step of a ticket, the button's label, and the undo (ADR 0026 moves). */
function nextStep(ticket: StationTicket): { status: SettableTicketStatus; label: LabelKey } | null {
  if (ticket.kind === 'void') {
    return ticket.status === 'new' ? { status: 'served', label: 'pos.kitchen.seen' } : null;
  }
  switch (ticket.status) {
    case 'new':
      return { status: 'preparing', label: 'pos.kitchen.start' };
    case 'preparing':
      return { status: 'ready', label: 'pos.kitchen.markReady' };
    case 'ready':
      return { status: 'served', label: 'pos.kitchen.markServed' };
    case 'served':
      return null;
  }
}

const undoOf = (status: TicketStatus): SettableTicketStatus | null =>
  status === 'ready' ? 'preparing' : null;

/**
 * /kitchen and /bar (docs/modules/pos.md → Kitchen and bar screens, ADR 0026): the station's
 * tickets at a location in New, Preparing and Ready, each card with one big next-step button.
 * Refreshes every 5 s while visible. Tablet first; on a phone the columns stack.
 */
export function StationBoardPage({ station }: { station: PrepStation }) {
  const t = useT();
  const { store, session } = useAuth();
  const allowed =
    !!session &&
    session.activeFeatures.includes('pos') &&
    session.activePermissions.includes(STATION_KEYS[station]);
  const [locations, reload] = useResource(
    allowed ? (session?.activeOrganizationId ?? null) : null,
    () => loadLocations(store),
  );
  const title = station === 'kitchen' ? 'pos.kitchen.title' : 'pos.kitchen.barTitle';
  if (!session) return null;
  if (!allowed) return <NoAccess title={title} />;
  return (
    <Loaded resource={locations} reload={reload}>
      {(list) =>
        list.length === 0 ? (
          <div className="flex flex-col gap-6">
            <h1 className="text-2xl font-semibold">{t(title)}</h1>
            <NoLocations message={t('pos.kitchen.noLocations')} />
          </div>
        ) : (
          <Board station={station} locations={list} />
        )
      }
    </Loaded>
  );
}

function Board({ station, locations }: { station: PrepStation; locations: LocationSummary[] }) {
  const t = useT();
  const id = useId();
  const { store } = useAuth();
  const [locationId, setLocationId] = useState(locations[0]!.id);
  const [board, reload] = useResource(`${station}:${locationId}`, () =>
    loadStationBoard(store, station, locationId),
  );
  const tick = useCallback(() => reload(), [reload]);
  const now = useNow(5_000, tick);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold">
            {t(station === 'kitchen' ? 'pos.kitchen.title' : 'pos.kitchen.barTitle')}
          </h1>
          <p className="text-sm text-muted-foreground">{t('pos.kitchen.updated')}</p>
        </div>
        {locations.length > 1 && (
          <div className="grid min-w-56 gap-1.5">
            <Label htmlFor={`${id}-location`}>{t('pos.kitchen.location')}</Label>
            <Select
              id={`${id}-location`}
              value={locationId}
              onChange={(e) => setLocationId(e.target.value)}
              data-testid="board-location"
            >
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
          </div>
        )}
      </div>
      <Notice text={error} tone="error" />
      <Loaded resource={board} reload={reload}>
        {(tickets) => (
          <div className="grid gap-4 md:grid-cols-3" data-testid="station-board">
            {COLUMNS.map((column) => {
              const cards = tickets.filter((ticket) =>
                column === 'ready'
                  ? ticket.status === 'ready' || ticket.status === 'served'
                  : ticket.status === column,
              );
              return (
                <section
                  key={column}
                  className="flex flex-col gap-3 rounded-xl border border-border bg-muted p-3"
                  aria-labelledby={`${id}-${column}`}
                  data-testid={`column-${column}`}
                >
                  <h2
                    id={`${id}-${column}`}
                    className="flex items-center justify-between font-semibold"
                  >
                    {t(`pos.kitchen.columns.${column}`)}
                    <span className="rounded-full bg-card px-2 text-sm tabular-nums">
                      {cards.filter((c) => c.status !== 'served').length}
                    </span>
                  </h2>
                  {cards.length === 0 && (
                    <p className="py-6 text-center text-sm text-muted-foreground">
                      {t('pos.kitchen.empty')}
                    </p>
                  )}
                  {cards.map((ticket) => (
                    <TicketCard
                      key={ticket.id}
                      station={station}
                      ticket={ticket}
                      now={now}
                      onMoved={reload}
                      onError={setError}
                    />
                  ))}
                </section>
              );
            })}
          </div>
        )}
      </Loaded>
    </div>
  );
}

function TicketCard({
  station,
  ticket,
  now,
  onMoved,
  onError,
}: {
  station: PrepStation;
  ticket: StationTicket;
  now: number;
  onMoved: () => void;
  onError: (message: string | null) => void;
}) {
  const t = useT();
  const { store } = useAuth();
  const action = useActionKey();
  const [busy, setBusy] = useState(false);
  const minutes = Math.max(0, Math.floor((now - Date.parse(ticket.createdAt)) / 60_000));
  const step = nextStep(ticket);
  const undo = undoOf(ticket.status);
  const served = ticket.status === 'served';

  async function move(status: SettableTicketStatus) {
    setBusy(true);
    onError(null);
    const result = await moveTicket(store, action, station, ticket.id, status);
    setBusy(false);
    if (!result.ok) onError(t(errorLabel(result.code)));
    // Moved, or someone else moved it first (409): either way show the board as it is now.
    onMoved();
  }

  return (
    <article
      className={cn(
        'flex flex-col gap-2 rounded-lg border-2 border-border bg-card p-3 text-foreground shadow-sm',
        ticket.kind === 'void' && 'border-destructive',
        served && 'opacity-60',
      )}
      data-testid="station-ticket"
      data-status={ticket.status}
      data-table={ticket.tableName}
    >
      <header className="flex items-start justify-between gap-2">
        <div>
          <p className="text-2xl leading-tight font-bold">
            {t('pos.kitchen.table', { table: ticket.tableName })}
          </p>
          <p className="text-sm text-muted-foreground">
            {t('pos.kitchen.ticket', {
              number: ticket.orderNumber,
              sequence: String(ticket.sequence),
            })}
          </p>
        </div>
        <span
          className={cn(
            'rounded-md px-2 py-0.5 text-sm font-semibold tabular-nums',
            minutes >= VERY_LATE_MINUTES
              ? 'bg-destructive text-primary-foreground'
              : minutes >= LATE_MINUTES
                ? 'bg-accent text-accent-foreground'
                : 'bg-muted text-foreground',
          )}
          data-testid="ticket-age"
        >
          {t('pos.kitchen.age', { minutes: String(minutes) })}
        </span>
      </header>
      {ticket.kind === 'void' && (
        <p className="text-xl font-bold text-destructive">{t('pos.kitchen.cancelled')}</p>
      )}
      <ul className="flex flex-col gap-1">
        {ticket.lines.map((line) => (
          <li key={line.id} className="grid grid-cols-[2.5ch_1fr] gap-x-2 text-lg">
            <span className="font-bold tabular-nums">{Math.abs(line.quantity)}</span>
            <span className={cn(ticket.kind === 'void' && 'line-through')}>{line.productName}</span>
            {line.note && <span className="col-start-2 text-base italic">{line.note}</span>}
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        {step && (
          <Button
            className="min-h-12 flex-1 text-base"
            disabled={busy}
            onClick={() => void move(step.status)}
            data-testid="ticket-next"
          >
            {t(step.label)}
          </Button>
        )}
        {served && (
          <p className="flex min-h-12 flex-1 items-center text-base font-semibold">
            {t('pos.kitchen.served')}
          </p>
        )}
        {undo && (
          <Button
            variant="outline"
            className="min-h-12 gap-2"
            disabled={busy}
            onClick={() => void move(undo)}
            aria-label={t('pos.kitchen.undo')}
            data-testid="ticket-undo"
          >
            <Undo2 aria-hidden />
          </Button>
        )}
      </div>
    </article>
  );
}
