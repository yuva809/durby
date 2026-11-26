'use client';

import { bookingSlugSchema, type BookingPageResponse } from '@durby/shared';
import { Copy } from 'lucide-react';
import { useId, useState } from 'react';
import { Notice } from '../../app/auth-layout';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { type ApiErrorCode, errorLabel } from '../../lib/auth/errors';
import { loadBookingPage, saveBookingPage } from '../../lib/reservations/api';
import { useActionKey } from '../../lib/use-action-key';
import { useResource } from '../../lib/use-resource';
import { Field } from '../form-dialog';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Checkbox } from '../ui/checkbox';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Loaded } from '../users/common';

/**
 * Settings → Reservations: the location's online booking page (docs/modules/reservations.md → R2.1). The address is
 * `/b/{slug}` on the domain this page runs on (the restaurant's partner domain).
 */
export function BookingPageCard({ locationId }: { locationId: string }) {
  const t = useT();
  const { store, session } = useAuth();
  const [resource, reload] = useResource(locationId, () => loadBookingPage(store, locationId));
  const canEdit = session?.activePermissions.includes('reservations.setup.edit') ?? false;
  return (
    <Card className="flex flex-col gap-4 p-4 sm:p-6" data-testid="booking-page-card">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold">{t('reservations.bookingPage.title')}</h2>
        <p className="text-sm text-muted-foreground">{t('reservations.bookingPage.intro')}</p>
      </div>
      <Loaded resource={resource} reload={reload}>
        {(data) => (
          <BookingPageForm
            key={`${locationId}:${data.page?.slug ?? ''}:${String(data.page?.enabled)}`}
            locationId={locationId}
            data={data}
            canEdit={canEdit}
            onSaved={reload}
          />
        )}
      </Loaded>
    </Card>
  );
}

function BookingPageForm({
  locationId,
  data,
  canEdit,
  onSaved,
}: {
  locationId: string;
  data: BookingPageResponse;
  canEdit: boolean;
  onSaved: () => void;
}) {
  const t = useT();
  const { store } = useAuth();
  const action = useActionKey();
  const id = useId();
  const [slug, setSlug] = useState(data.page?.slug ?? data.suggestedSlug);
  const [enabled, setEnabled] = useState(data.page?.enabled ?? true);
  const [problem, setProblem] = useState<string | null>(null);
  const [failure, setFailure] = useState<ApiErrorCode | 'unknown' | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const link = data.page ? `${window.location.origin}${data.page.path}` : null;
  const changed = !data.page || slug !== data.page.slug || enabled !== data.page.enabled;

  async function save() {
    const parsed = bookingSlugSchema.safeParse(slug);
    if (!parsed.success) {
      setProblem(t('reservations.bookingPage.slugInvalid'));
      return;
    }
    setProblem(null);
    setFailure(null);
    setBusy(true);
    const result = await saveBookingPage(store, action, { locationId, slug: parsed.data, enabled });
    setBusy(false);
    if (result.ok) {
      setNote(t('reservations.bookingPage.saved'));
      onSaved();
    } else {
      setFailure(result.code);
    }
  }

  async function copy() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setNote(t('reservations.bookingPage.copied'));
    } catch {
      setNote(link);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {!data.online && <Notice text={t('reservations.bookingPage.off')} tone="info" />}
      <Field id={`${id}-slug`} label={t('reservations.bookingPage.slug')} problem={problem}>
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 text-sm text-muted-foreground">/b/</span>
          <Input
            id={`${id}-slug`}
            className="min-w-0"
            value={slug}
            disabled={!canEdit}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setSlug(e.target.value.toLowerCase())}
            data-testid="booking-page-slug"
          />
        </div>
      </Field>
      <p className="-mt-2 text-xs text-muted-foreground">
        {t('reservations.bookingPage.slugHint')}
      </p>
      <div className="flex items-center gap-2">
        <Checkbox
          id={`${id}-enabled`}
          checked={enabled}
          disabled={!canEdit}
          onCheckedChange={(next) => setEnabled(next === true)}
          data-testid="booking-page-enabled"
        />
        <Label htmlFor={`${id}-enabled`} className="font-normal">
          {t('reservations.bookingPage.enabled')}
        </Label>
      </div>
      {link && (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{t('reservations.bookingPage.link')}</span>
          <code
            className="min-w-0 rounded bg-muted px-2 py-1 text-sm break-all"
            data-testid="booking-page-link"
          >
            {link}
          </code>
          <Button variant="outline" onClick={() => void copy()} data-testid="booking-page-copy">
            <Copy aria-hidden />
            {t('reservations.bookingPage.copy')}
          </Button>
        </div>
      )}
      {data.page && (
        <p className="text-xs text-muted-foreground">{t('reservations.bookingPage.comingSoon')}</p>
      )}
      <Notice text={failure ? t(errorLabel(failure)) : null} tone="error" />
      {note && (
        <p className="text-sm text-muted-foreground" role="status">
          {note}
        </p>
      )}
      {canEdit && (
        <div>
          <Button
            disabled={busy || !changed}
            onClick={() => void save()}
            data-testid="booking-page-save"
          >
            {t('platform.common.save')}
          </Button>
        </div>
      )}
    </div>
  );
}
