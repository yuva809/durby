'use client';

import { LOCALES, type Locale } from '@durby/i18n';
import Link from 'next/link';
import { useId, useState } from 'react';
import { Notice } from '../../app/auth-layout';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { updateMe } from '../../lib/account/api';
import { errorLabel } from '../../lib/auth/errors';
import { localeOf } from '../../lib/labels/labels';
import { useActionKey } from '../../lib/use-action-key';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Label } from '../ui/label';
import { Select } from '../ui/select';

/** /account: your own profile; today the language of the screens and of mails to you. */
export function AccountPage() {
  const t = useT();
  const { store, session } = useAuth();
  const action = useActionKey();
  const id = useId();
  const [choice, setChoice] = useState<Locale | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; tone: 'error' | 'info' } | null>(null);
  if (!session) return null;
  const current = localeOf(session);
  const selected = choice ?? current;

  async function save() {
    setBusy(true);
    setNotice(null);
    const result = await updateMe(store, action, { locale: selected });
    if (result.ok) {
      // The session carries the language: a fresh one switches screens and labels over.
      await store.refresh();
      setChoice(null);
      setNotice({ text: t('platform.account.saved'), tone: 'info' });
    } else {
      setNotice({ text: t(errorLabel(result.code)), tone: 'error' });
    }
    setBusy(false);
  }

  return (
    <div className="flex max-w-xl flex-col gap-6">
      <h1 className="text-2xl font-semibold">{t('platform.account.title')}</h1>
      <Card className="flex flex-col gap-5 p-6">
        <div className="grid gap-1">
          <span className="text-sm text-muted-foreground">{t('platform.account.email')}</span>
          <span className="font-medium" data-testid="account-email">
            {session.user.email}
          </span>
        </div>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-language`}>{t('platform.account.language')}</Label>
            <Select
              id={`${id}-language`}
              value={selected}
              onChange={(e) => setChoice(e.target.value as Locale)}
              aria-describedby={`${id}-language-hint`}
            >
              {LOCALES.map((locale) => (
                <option key={locale} value={locale}>
                  {t(`platform.account.languages.${locale}`)}
                </option>
              ))}
            </Select>
            <p id={`${id}-language-hint`} className="text-sm text-muted-foreground">
              {t('platform.account.languageHint')}
            </p>
          </div>
          <Notice text={notice?.text ?? null} tone={notice?.tone ?? 'info'} />
          <div>
            <Button
              type="submit"
              disabled={busy || selected === current}
              data-testid="account-save"
            >
              {t('platform.common.save')}
            </Button>
          </div>
        </form>
      </Card>
      <Card className="flex items-center justify-between gap-4 p-6">
        <div className="grid gap-1">
          <span className="font-medium">{t('platform.notifications.settings.title')}</span>
          <span className="text-sm text-muted-foreground">
            {t('platform.notifications.settings.summary')}
          </span>
        </div>
        <Button asChild variant="outline">
          <Link href="/account/notifications" data-testid="account-notifications">
            {t('platform.notifications.settings.open')}
          </Link>
        </Button>
      </Card>
    </div>
  );
}
