'use client';

import {
  type Feedback,
  FEEDBACK_CATEGORIES,
  FEEDBACK_MESSAGE_MAX_LENGTH,
  feedbackListResponseSchema,
  feedbackSchema,
  type FeedbackCategory,
  type SendFeedbackRequest,
} from '@durby/shared';
import { MessageSquareHeart } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { type FormEvent, useId, useMemo, useState } from 'react';
import { Notice } from '../../app/auth-layout';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { type Api, list, read, write } from '../../lib/api-call';
import { errorLabel } from '../../lib/auth/errors';
import type { ActionKey } from '../../lib/idempotency';
import { useActionKey } from '../../lib/use-action-key';
import { useResource } from '../../lib/use-resource';
import { cn } from '../../lib/utils';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Label } from '../ui/label';
import { Loaded, NoAccess } from '../users/common';

const loadFeedback = (store: Api) =>
  read(store, '/api/v1/feedback', list(feedbackListResponseSchema));
const sendFeedback = (store: Api, action: ActionKey, body: SendFeedbackRequest) =>
  write(store, action, '/api/v1/feedback', 'POST', body, feedbackSchema);

/**
 * /feedback (docs/platform/feedback.md, ADR 0044 step 5): tell the team behind the app about a bug, an idea or a question, and
 * see what the organization sent and where it stands. `?from=/orders` names the page it is about.
 */
export function FeedbackPage() {
  const { session } = useAuth();
  if (!session) return null;
  if (!session.activePermissions.includes('platform.feedback.send'))
    return <NoAccess title="platform.nav.feedback" />;
  return <FeedbackForm organizationId={session.activeOrganizationId} />;
}

function FeedbackForm({ organizationId }: { organizationId: string | null }) {
  const t = useT();
  const { store } = useAuth();
  const id = useId();
  const action = useActionKey();
  const from = useSearchParams().get('from');
  const pagePath = from && /^\/[^\s]{0,199}$/.test(from) ? from : undefined;
  const [category, setCategory] = useState<FeedbackCategory>('idea');
  const [message, setMessage] = useState('');
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [history, reload] = useResource(organizationId, () => loadFeedback(store));
  const date = useMemo(() => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }), []);
  const missing = checked && message.trim() === '';

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setChecked(true);
    setSent(false);
    if (message.trim() === '') return;
    setBusy(true);
    setError(null);
    const result = await sendFeedback(store, action, {
      category,
      message: message.trim(),
      ...(pagePath ? { pagePath } : {}),
    });
    setBusy(false);
    if (!result.ok) {
      setError(t(errorLabel(result.code)));
      return;
    }
    action.done();
    setMessage('');
    setChecked(false);
    setSent(true);
    reload();
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{t('platform.nav.feedback')}</h1>
        <p className="text-muted-foreground">{t('platform.feedbackPage.intro')}</p>
      </div>
      <Card className="max-w-2xl p-4">
        <form className="flex flex-col gap-4" onSubmit={(e) => void onSubmit(e)} noValidate>
          <div
            role="radiogroup"
            aria-label={t('platform.feedbackPage.category')}
            className="flex flex-wrap gap-2"
          >
            {FEEDBACK_CATEGORIES.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={c === category}
                onClick={() => setCategory(c)}
                className={cn(
                  'min-h-11 rounded-md border px-4 text-sm font-medium hover:bg-muted',
                  c === category && 'border-primary bg-muted ring-1 ring-primary',
                )}
                data-testid={`feedback-category-${c}`}
              >
                {t(`platform.feedback.categories.${c}`)}
              </button>
            ))}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-message`}>{t('platform.feedbackPage.message')}</Label>
            <textarea
              id={`${id}-message`}
              value={message}
              maxLength={FEEDBACK_MESSAGE_MAX_LENGTH}
              rows={6}
              aria-invalid={missing || undefined}
              aria-describedby={`${id}-hint`}
              onChange={(e) => setMessage(e.target.value)}
              className="rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              data-testid="feedback-message"
            />
            <p id={`${id}-hint`} className="text-sm text-muted-foreground">
              {pagePath
                ? t('platform.feedbackPage.aboutPage', { page: pagePath })
                : t('platform.feedbackPage.hint')}
            </p>
            {missing && (
              <p role="alert" className="text-sm text-destructive">
                {t('platform.feedbackPage.messageRequired')}
              </p>
            )}
          </div>
          <Notice text={error} tone="error" />
          {sent && <Notice text={t('platform.feedbackPage.sent')} tone="info" />}
          <Button type="submit" disabled={busy} className="self-start" data-testid="feedback-send">
            {t('platform.feedbackPage.send')}
          </Button>
        </form>
      </Card>

      <section className="flex flex-col gap-2" aria-labelledby={`${id}-history`}>
        <h2 id={`${id}-history`} className="text-lg font-medium">
          {t('platform.feedbackPage.history')}
        </h2>
        <Loaded resource={history} reload={reload}>
          {(items: Feedback[]) =>
            items.length === 0 ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <MessageSquareHeart aria-hidden className="size-4" />
                {t('platform.feedbackPage.empty')}
              </p>
            ) : (
              <Card className="max-w-2xl p-0">
                <ul className="divide-y" data-testid="feedback-history">
                  {items.map((item) => (
                    <li
                      key={item.id}
                      className="flex flex-col gap-1 px-4 py-3"
                      data-testid="feedback-item"
                    >
                      <span className="flex flex-wrap items-center gap-2 text-sm">
                        <Badge>{t(`platform.feedback.categories.${item.category}`)}</Badge>
                        <Badge data-testid="feedback-status">
                          {t(`platform.feedback.statuses.${item.status}`)}
                        </Badge>
                        <span className="text-muted-foreground">
                          {date.format(new Date(item.createdAt))}
                        </span>
                      </span>
                      <p className="text-sm whitespace-pre-wrap">{item.message}</p>
                    </li>
                  ))}
                </ul>
              </Card>
            )
          }
        </Loaded>
      </section>
    </div>
  );
}
