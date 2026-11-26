'use client';

import { LOCALES, type Locale } from '@durby/i18n';
import {
  WAITLIST_MAX_QUOTED_MINUTES,
  WAITLIST_NAME_MAX,
  WAITLIST_NOTE_MAX,
  type WaitlistEntry,
} from '@durby/shared';
import { useId, useState } from 'react';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import type { ApiErrorCode } from '../../lib/auth/errors';
import { errorLabel } from '../../lib/auth/errors';
import { addEntry, removeEntry, updateEntry } from '../../lib/reservations/waitlist';
import { useActionKey } from '../../lib/use-action-key';
import { Field } from '../form-dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Select } from '../ui/select';
import { ConfirmAction } from '../users/common';
import { HostDialog, partyOk, trimmed } from './host-dialogs';

const QUICK_PARTIES = [1, 2, 3, 4, 5, 6, 8];

/** "" = not set; null = not a whole number of minutes the api takes. */
function minutesOf(text: string): number | undefined | null {
  if (text.trim() === '') return undefined;
  const n = Number(text);
  return Number.isInteger(n) && n >= 0 && n <= WAITLIST_MAX_QUOTED_MINUTES ? n : null;
}

/** Add a party to the waitlist or change one; changing also offers to remove it (added by mistake). */
export function WaitlistDialog({
  locationId,
  entry,
  canRemove,
  onClose,
  onDone,
}: {
  locationId: string;
  entry: WaitlistEntry | null;
  canRemove: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useT();
  const { store } = useAuth();
  const action = useActionKey();
  const removeAction = useActionKey();
  const id = useId();
  const [form, setForm] = useState({
    party: String(entry?.partySize ?? 2),
    name: entry?.name ?? '',
    phone: entry?.phone ?? '',
    email: entry?.email ?? '',
    // "" = the branch's language (the api's default).
    locale: entry?.locale ?? '',
    quoted: entry?.quotedMinutes == null ? '' : String(entry.quotedMinutes),
    note: entry?.note ?? '',
  });
  const [problems, setProblems] = useState<{ party?: string; name?: string; quoted?: string }>({});
  const [failure, setFailure] = useState<ApiErrorCode | 'unknown' | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (field: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [field]: e.target.value }));

  async function submit() {
    const partySize = Number(form.party);
    const name = trimmed(form.name);
    const quoted = minutesOf(form.quoted);
    setProblems({
      ...(!partyOk(partySize) && { party: t('reservations.host.partyInvalid') }),
      ...(!name && { name: t('reservations.waitlist.nameRequired') }),
      ...(quoted === null && {
        quoted: t('reservations.waitlist.quotedInvalid', {
          max: String(WAITLIST_MAX_QUOTED_MINUTES),
        }),
      }),
    });
    if (!partyOk(partySize) || !name || quoted === null) return;
    const locale = form.locale === '' ? undefined : (form.locale as Locale);
    const contact = {
      phone: trimmed(form.phone),
      email: trimmed(form.email),
      note: trimmed(form.note),
    };
    setBusy(true);
    setFailure(null);
    const result = entry
      ? await updateEntry(store, action, entry.id, {
          name,
          partySize,
          phone: contact.phone ?? null,
          email: contact.email ?? null,
          note: contact.note ?? null,
          quotedMinutes: quoted ?? null,
          locale,
        })
      : await addEntry(store, action, {
          locationId,
          name,
          partySize,
          ...contact,
          quotedMinutes: quoted,
          locale,
        });
    setBusy(false);
    if (result.ok) {
      onClose();
      onDone();
    } else {
      setFailure(result.code);
    }
  }

  return (
    <HostDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t(entry ? 'reservations.waitlist.editTitle' : 'reservations.waitlist.addTitle')}
      testId="waitlist-dialog"
      submitLabel={t(entry ? 'platform.common.save' : 'reservations.waitlist.submit')}
      busy={busy}
      error={failure ? t(errorLabel(failure)) : null}
      onSubmit={() => void submit()}
    >
      <Field
        id={`${id}-party`}
        label={t('reservations.host.party')}
        problem={problems.party ?? null}
      >
        <div className="flex flex-wrap gap-2">
          {QUICK_PARTIES.map((n) => (
            <Button
              key={n}
              type="button"
              variant={form.party === String(n) ? 'default' : 'outline'}
              aria-pressed={form.party === String(n)}
              className="min-w-11 px-3 tabular-nums"
              data-testid={`waitlist-party-${n}`}
              onClick={() => setForm((f) => ({ ...f, party: String(n) }))}
            >
              {n}
            </Button>
          ))}
          <Input
            id={`${id}-party`}
            type="number"
            inputMode="numeric"
            min={1}
            max={100}
            className="w-20"
            value={form.party}
            onChange={set('party')}
          />
        </div>
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          id={`${id}-name`}
          label={t('reservations.host.guestName')}
          problem={problems.name ?? null}
        >
          <Input
            id={`${id}-name`}
            autoComplete="off"
            maxLength={WAITLIST_NAME_MAX}
            value={form.name}
            onChange={set('name')}
          />
        </Field>
        <Field
          id={`${id}-quoted`}
          label={t('reservations.waitlist.quoted')}
          problem={problems.quoted ?? null}
        >
          <Input
            id={`${id}-quoted`}
            type="number"
            inputMode="numeric"
            min={0}
            max={WAITLIST_MAX_QUOTED_MINUTES}
            step={5}
            value={form.quoted}
            onChange={set('quoted')}
          />
        </Field>
        <Field id={`${id}-phone`} label={t('reservations.host.phone')} problem={null}>
          <Input
            id={`${id}-phone`}
            type="tel"
            autoComplete="off"
            value={form.phone}
            onChange={set('phone')}
          />
        </Field>
        <Field id={`${id}-email`} label={t('reservations.host.email')} problem={null}>
          <Input
            id={`${id}-email`}
            type="email"
            autoComplete="off"
            value={form.email}
            onChange={set('email')}
          />
        </Field>
        <Field id={`${id}-locale`} label={t('reservations.waitlist.language')} problem={null}>
          <Select id={`${id}-locale`} value={form.locale} onChange={set('locale')}>
            {!entry && <option value="">{t('reservations.waitlist.languageDefault')}</option>}
            {LOCALES.map((locale) => (
              <option key={locale} value={locale}>
                {t(`platform.settings.locale.options.${locale}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field id={`${id}-note`} label={t('reservations.waitlist.note')} problem={null}>
          <Input
            id={`${id}-note`}
            autoComplete="off"
            maxLength={WAITLIST_NOTE_MAX}
            value={form.note}
            onChange={set('note')}
          />
        </Field>
      </div>
      <p className="text-sm text-muted-foreground">{t('reservations.waitlist.privacy')}</p>
      {entry && canRemove && (
        <div className="border-t pt-4">
          <ConfirmAction
            trigger={t('reservations.waitlist.remove')}
            title={t('reservations.waitlist.removeTitle', { name: entry.name ?? '' })}
            description={t('reservations.waitlist.removeDescription')}
            confirm={t('reservations.waitlist.remove')}
            testId="waitlist-remove"
            run={() => removeEntry(store, removeAction, entry.id)}
            onDone={() => {
              onClose();
              onDone();
            }}
          />
        </div>
      )}
    </HostDialog>
  );
}
