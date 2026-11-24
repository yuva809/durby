'use client';

import type { LabelKey } from '@durby/i18n';
import { Lock } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Notice } from '../../app/auth-layout';
import { useT } from '../../app/labels-provider';
import { errorLabel } from '../../lib/auth/errors';
import type { Resource } from '../../lib/use-resource';
import type { Result } from '../../lib/users/api';
import { Button } from '../ui/button';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '../ui/alert-dialog';
import { Card } from '../ui/card';
import { Skeleton } from '../ui/skeleton';

/** A settings page the user's role doesn't include (a UI hint; the api enforces anyway). */
export function NoAccess({ title }: { title: LabelKey }) {
  const t = useT();
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">{t(title)}</h1>
      <Card
        className="flex flex-col items-center gap-2 px-6 py-12 text-center"
        data-testid="no-access"
      >
        <Lock aria-hidden className="size-8 text-muted-foreground" />
        <h2 className="text-lg font-medium">{t('platform.shell.noAccess.title')}</h2>
        <p className="max-w-sm text-muted-foreground">{t('platform.shell.noAccess.description')}</p>
      </Card>
    </div>
  );
}

/** Loading skeleton or load error (with retry) of a list; `children` once it is ready. */
export function Loaded<T>({
  resource,
  reload,
  children,
}: {
  resource: Resource<T>;
  reload: () => void;
  children: (data: T) => ReactNode;
}) {
  const t = useT();
  if (resource.status === 'loading') {
    return (
      <div className="flex flex-col gap-2" aria-busy="true">
        <Skeleton className="h-11 w-full" />
        <Skeleton className="h-11 w-full" />
      </div>
    );
  }
  if (resource.status === 'error') {
    return (
      <div className="flex flex-col items-start gap-2">
        <Notice text={t(errorLabel(resource.code))} tone="error" />
        <Button variant="outline" onClick={reload}>
          {t('platform.common.retry')}
        </Button>
      </div>
    );
  }
  return <>{children(resource.data)}</>;
}

/**
 * A destructive action behind a confirm dialog. `run` sends the write (with its own ActionKey);
 * on success the dialog closes and `onDone` runs, on failure the error label shows in the dialog.
 */
export function ConfirmAction({
  trigger,
  title,
  description,
  confirm,
  run,
  onDone,
  testId,
  triggerIcon,
  variant = 'destructive',
  fallback,
}: {
  trigger: string;
  /** An icon-only trigger; `trigger` becomes its accessible name. */
  triggerIcon?: ReactNode;
  title: string;
  description: string;
  confirm: string;
  run: () => Promise<Result<unknown>>;
  onDone: () => void;
  testId?: string;
  /** The trigger's and confirm button's look: destructive (the default), or plain for a positive step. */
  variant?: 'destructive' | 'default';
  /**
   * What to offer when `run` fails with `code` (e.g. Archive when an item with history can't be deleted): its button
   * replaces the confirm button.
   */
  fallback?: {
    code: string;
    /** Shown above the buttons when they are offered (e.g. what deleting with history does). */
    note?: string;
    options: readonly {
      label: string;
      run: () => Promise<Result<unknown>>;
      destructive?: boolean;
      testId?: string;
    }[];
  };
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offer, setOffer] = useState(false);

  async function onConfirm(step: () => Promise<Result<unknown>> = run) {
    setBusy(true);
    setError(null);
    const result = await step();
    setBusy(false);
    if (result.ok) {
      setOpen(false);
      setOffer(false);
      onDone();
    } else {
      setError(t(errorLabel(result.code)));
      if (fallback && result.code === fallback.code) setOffer(true);
    }
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setError(null);
          setOffer(false);
        }
      }}
    >
      <AlertDialogTrigger asChild>
        {triggerIcon ? (
          <Button variant="outline" size="icon" aria-label={trigger} data-testid={testId}>
            {triggerIcon}
          </Button>
        ) : (
          <Button variant={variant} data-testid={testId}>
            {trigger}
          </Button>
        )}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogTitle>{title}</AlertDialogTitle>
        <AlertDialogDescription>{description}</AlertDialogDescription>
        <Notice text={error} tone="error" />
        {offer && fallback?.note && (
          <p className="text-sm text-muted-foreground" data-testid="confirm-fallback-note">
            {fallback.note}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>{t('platform.common.cancel')}</AlertDialogCancel>
          {/* Not AlertDialogAction: that closes the dialog before the answer is known. */}
          {offer && fallback ? (
            fallback.options.map((option) => (
              <Button
                key={option.label}
                variant={option.destructive ? 'destructive' : 'default'}
                disabled={busy}
                onClick={() => void onConfirm(option.run)}
                data-testid={option.testId}
              >
                {option.label}
              </Button>
            ))
          ) : (
            <Button variant={variant} disabled={busy} onClick={() => void onConfirm()}>
              {confirm}
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
