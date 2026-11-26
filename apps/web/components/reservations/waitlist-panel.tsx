'use client';

import type { LabelKey } from '@durby/i18n';
import type { WaitlistEntry, WaitlistResponse } from '@durby/shared';
import { Mail, MessageSquare, Pencil, Phone, TriangleAlert, Users } from 'lucide-react';
import { useId, useState } from 'react';
import { Notice } from '../../app/auth-layout';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import type { Result } from '../../lib/api-call';
import type { ApiErrorCode } from '../../lib/auth/errors';
import { errorLabel } from '../../lib/auth/errors';
import { clockTime } from '../../lib/reservations/host';
import {
  callLink,
  canEmail,
  messageLink,
  moveEntry,
  notifyEntry,
  overHold,
  overQuoted,
  waitedMinutes,
} from '../../lib/reservations/waitlist';
import { useActionKey } from '../../lib/use-action-key';
import type { Resource } from '../../lib/use-resource';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Loaded } from '../users/common';
import { WaitlistDialog } from './waitlist-dialog';

/** What the signed-in person may do with the list. */
export interface WaitlistRights {
  create: boolean;
  edit: boolean;
  remove: boolean;
  seat: boolean;
}

/**
 * The waitlist column of /host, today only (docs/modules/reservations.md → Waitlist): parties in the
 * order they were added. Other devices' changes arrive with the page's live reload.
 */
export function WaitlistPanel({
  locationId,
  timeZone,
  resource,
  reload,
  now,
  rights,
  onSeat,
}: {
  locationId: string;
  timeZone: string;
  resource: Resource<WaitlistResponse>;
  reload: () => void;
  now: number;
  rights: WaitlistRights;
  onSeat: (entry: WaitlistEntry) => void;
}) {
  const t = useT();
  const id = useId();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<WaitlistEntry | null>(null);
  const count = resource.status === 'ready' ? resource.data.open.length : 0;
  return (
    <section
      className="flex flex-col gap-3 lg:col-span-2 2xl:col-span-1"
      aria-labelledby={`${id}-title`}
      data-testid="waitlist"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={`${id}-title`} className="text-lg font-semibold">
          {t('reservations.waitlist.title')}
          {count > 0 && <span className="ml-2 text-muted-foreground tabular-nums">{count}</span>}
        </h2>
        {rights.create && (
          <Button variant="outline" data-testid="waitlist-add" onClick={() => setAdding(true)}>
            {t('reservations.waitlist.add')}
          </Button>
        )}
      </div>
      <Loaded resource={resource} reload={reload}>
        {(list) => (
          <>
            {list.open.length === 0 ? (
              <p className="text-muted-foreground">{t('reservations.waitlist.empty')}</p>
            ) : (
              <ol className="grid gap-2 lg:grid-cols-2 2xl:grid-cols-1">
                {list.open.map((entry, i) => (
                  <Row
                    key={entry.id}
                    entry={entry}
                    position={i + 1}
                    list={list}
                    timeZone={timeZone}
                    now={now}
                    rights={rights}
                    reload={reload}
                    onSeat={onSeat}
                    onEdit={setEditing}
                  />
                ))}
              </ol>
            )}
            {list.ended.length > 0 && (
              <details className="rounded-lg border border-border bg-card px-3">
                <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium">
                  {t('reservations.waitlist.ended', { count: String(list.ended.length) })}
                </summary>
                <ul className="flex flex-col pb-2">
                  {list.ended.map((entry) => (
                    <EndedRow
                      key={entry.id}
                      entry={entry}
                      timeZone={timeZone}
                      canEdit={rights.edit}
                      reload={reload}
                    />
                  ))}
                </ul>
              </details>
            )}
          </>
        )}
      </Loaded>
      {(adding || editing) && (
        <WaitlistDialog
          locationId={locationId}
          entry={editing}
          canRemove={rights.remove}
          onClose={() => {
            setAdding(false);
            setEditing(null);
          }}
          onDone={reload}
        />
      )}
    </section>
  );
}

const nameOf = (entry: WaitlistEntry, t: ReturnType<typeof useT>) =>
  entry.name ?? t('reservations.guest.erased');

function Row({
  entry,
  position,
  list,
  timeZone,
  now,
  rights,
  reload,
  onSeat,
  onEdit,
}: {
  entry: WaitlistEntry;
  position: number;
  list: WaitlistResponse;
  timeZone: string;
  now: number;
  rights: WaitlistRights;
  reload: () => void;
  onSeat: (entry: WaitlistEntry) => void;
  onEdit: (entry: WaitlistEntry) => void;
}) {
  const t = useT();
  const { store } = useAuth();
  const emailAction = useActionKey();
  const toldAction = useActionKey();
  const leaveAction = useActionKey();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ApiErrorCode | 'unknown' | null>(null);

  async function run(send: () => Promise<Result<unknown>>) {
    setBusy(true);
    setFailure(null);
    const result = await send();
    setBusy(false);
    if (!result.ok) setFailure(result.code);
    // After a refusal too: another host may have changed the entry.
    reload();
  }

  const name = nameOf(entry, t);
  return (
    <li
      className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3"
      data-testid="waitlist-row"
      data-name={entry.name ?? ''}
      data-status={entry.status}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-lg font-semibold tabular-nums">{position}</span>
          <span className="min-w-0 font-medium break-words">{name}</span>
          <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
            <Users aria-hidden className="size-3.5" />
            {t('reservations.host.partyOf', { count: String(entry.partySize) })}
          </span>
        </span>
        <span className="text-sm text-muted-foreground tabular-nums" data-testid="waitlist-waited">
          {entry.quotedMinutes === null
            ? t('reservations.waitlist.waiting', { minutes: String(waitedMinutes(entry, now)) })
            : t('reservations.waitlist.waitingOf', {
                minutes: String(waitedMinutes(entry, now)),
                quoted: String(entry.quotedMinutes),
              })}
        </span>
      </div>
      <Told entry={entry} list={list} timeZone={timeZone} now={now} />
      {entry.note && <p className="text-sm break-words">{entry.note}</p>}
      <Notice text={failure ? t(errorLabel(failure)) : null} tone="error" />
      {(rights.edit || rights.seat) && (
        <div className="flex flex-wrap gap-2">
          {rights.edit && rights.seat && (
            <Button disabled={busy} data-testid="waitlist-seat" onClick={() => onSeat(entry)}>
              {t('reservations.waitlist.seat')}
            </Button>
          )}
          {rights.edit && (
            <>
              {entry.email !== null && (
                <Button
                  variant="outline"
                  disabled={busy || !canEmail(entry, now)}
                  data-testid="waitlist-email"
                  onClick={() => void run(() => notifyEntry(store, emailAction, entry.id, 'email'))}
                >
                  <Mail aria-hidden />
                  {t(
                    entry.emailCount > 0
                      ? 'reservations.waitlist.emailAgain'
                      : 'reservations.waitlist.email',
                  )}
                </Button>
              )}
              {entry.phone !== null && (
                <>
                  <Button asChild variant="outline">
                    <a href={callLink(entry.phone)} data-testid="waitlist-call">
                      <Phone aria-hidden />
                      {t('reservations.waitlist.call')}
                    </a>
                  </Button>
                  <Button asChild variant="outline">
                    <a
                      href={messageLink(entry.phone, list.readyText[entry.locale])}
                      data-testid="waitlist-message"
                    >
                      <MessageSquare aria-hidden />
                      {t('reservations.waitlist.message')}
                    </a>
                  </Button>
                </>
              )}
              <Button
                variant="outline"
                disabled={busy}
                data-testid="waitlist-told"
                onClick={() =>
                  void run(() => notifyEntry(store, toldAction, entry.id, 'in_person'))
                }
              >
                {t('reservations.waitlist.told')}
              </Button>
              <Button
                variant="outline"
                disabled={busy}
                data-testid="waitlist-leave"
                onClick={() => void run(() => moveEntry(store, leaveAction, entry.id, 'leave'))}
              >
                {t('reservations.waitlist.left')}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t('reservations.waitlist.editOf', { name })}
                data-testid="waitlist-edit"
                onClick={() => onEdit(entry)}
              >
                <Pencil aria-hidden />
              </Button>
            </>
          )}
        </div>
      )}
    </li>
  );
}

/** When and how the party was told, and what needs attention. */
function Told({
  entry,
  list,
  timeZone,
  now,
}: {
  entry: WaitlistEntry;
  list: WaitlistResponse;
  timeZone: string;
  now: number;
}) {
  const t = useT();
  if (overQuoted(entry, now)) {
    return <Alert testId="waitlist-over-quoted">{t('reservations.waitlist.overQuoted')}</Alert>;
  }
  if (entry.status !== 'notified' || entry.notifiedAt === null) return null;
  if (entry.noticeResult === 'failed') {
    return <Alert testId="waitlist-email-failed">{t('reservations.waitlist.emailFailed')}</Alert>;
  }
  const time = clockTime(entry.notifiedAt, timeZone);
  const label: LabelKey =
    entry.noticeChannel === 'in_person'
      ? 'reservations.waitlist.toldInPerson'
      : entry.noticeResult === 'sent'
        ? 'reservations.waitlist.toldByEmail'
        : 'reservations.waitlist.emailPending';
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge className="border-primary text-primary-text" data-testid="waitlist-notice">
        {t(label, { time })}
      </Badge>
      {overHold(entry, now, list.holdMinutes) && (
        <Alert testId="waitlist-over-hold">
          {t('reservations.waitlist.overHold', { minutes: String(list.holdMinutes) })}
        </Alert>
      )}
    </div>
  );
}

function Alert({ testId, children }: { testId: string; children: string }) {
  return (
    <span
      className="inline-flex items-center gap-1 text-sm font-medium text-destructive"
      data-testid={testId}
    >
      <TriangleAlert aria-hidden className="size-4 shrink-0" />
      {children}
    </span>
  );
}

const ENDED_LABEL: Partial<Record<WaitlistEntry['status'], LabelKey>> = {
  seated: 'reservations.waitlist.status.seated',
  left: 'reservations.waitlist.status.left',
  removed: 'reservations.waitlist.status.removed',
};

function EndedRow({
  entry,
  timeZone,
  canEdit,
  reload,
}: {
  entry: WaitlistEntry;
  timeZone: string;
  canEdit: boolean;
  reload: () => void;
}) {
  const t = useT();
  const { store } = useAuth();
  const action = useActionKey();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ApiErrorCode | 'unknown' | null>(null);
  const label = ENDED_LABEL[entry.status];

  async function back() {
    setBusy(true);
    setFailure(null);
    const result = await moveEntry(store, action, entry.id, 'return');
    setBusy(false);
    if (!result.ok) setFailure(result.code);
    reload();
  }

  return (
    <li
      className="flex flex-col gap-1 border-t border-border py-1"
      data-testid="waitlist-ended-row"
      data-name={entry.name ?? ''}
    >
      <div className="flex min-h-11 flex-wrap items-center justify-between gap-2 text-sm">
        <span className="min-w-0 break-words">
          {nameOf(entry, t)} · {t('reservations.host.partyOf', { count: String(entry.partySize) })}
          <span className="text-muted-foreground">
            {' · '}
            {label && t(label)} {entry.endedAt && clockTime(entry.endedAt, timeZone)}
          </span>
        </span>
        {entry.status === 'left' && canEdit && (
          <Button
            variant="outline"
            disabled={busy}
            data-testid="waitlist-return"
            onClick={() => void back()}
          >
            {t('reservations.waitlist.return')}
          </Button>
        )}
      </div>
      <Notice text={failure ? t(errorLabel(failure)) : null} tone="error" />
    </li>
  );
}
