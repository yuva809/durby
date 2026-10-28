'use client';

import { type FormEvent, type ReactNode, useState } from 'react';
import { Notice } from '../app/auth-layout';
import { useT } from '../app/labels-provider';
import { errorLabel } from '../lib/auth/errors';
import type { Result } from '../lib/api-call';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogFooter, DialogTitle, DialogTrigger } from './ui/dialog';
import { Label } from './ui/label';
import { ConfirmAction } from './users/common';

/** A label, its control and the control's problem text (`role="alert"`). */
export function Field({
  id,
  label,
  problem,
  children,
}: {
  id: string;
  label: string;
  problem: string | null;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {problem && (
        <p id={`${id}-problem`} role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      )}
    </div>
  );
}

/**
 * A dialog with a form. `submit` returns null when the form has problems (shown inline by the
 * fields), or the write; on success the dialog closes and `onDone` runs, on failure the error's
 * label shows in the dialog.
 */
export function FormDialog({
  trigger,
  triggerVariant,
  triggerIcon,
  testId,
  title,
  onOpen,
  submit,
  onDone,
  children,
}: {
  trigger: string;
  triggerVariant: 'default' | 'outline';
  /** An icon-only trigger; `trigger` becomes its accessible name. */
  triggerIcon?: ReactNode;
  testId: string;
  title: string;
  onOpen: () => void;
  submit: () => Promise<Result<unknown>> | null;
  onDone: () => void;
  children: ReactNode;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const pending = submit();
    if (!pending) return;
    setBusy(true);
    setError(null);
    const result = await pending;
    setBusy(false);
    if (result.ok) {
      setOpen(false);
      onDone();
    } else {
      setError(t(errorLabel(result.code)));
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          onOpen();
          setError(null);
        }
      }}
    >
      <DialogTrigger asChild>
        {triggerIcon ? (
          <Button variant={triggerVariant} size="icon" aria-label={trigger} data-testid={testId}>
            {triggerIcon}
          </Button>
        ) : (
          <Button variant={triggerVariant} data-testid={testId}>
            {trigger}
          </Button>
        )}
      </DialogTrigger>
      <DialogContent closeLabel={t('platform.common.close')} aria-describedby={undefined}>
        <DialogTitle>{title}</DialogTitle>
        <form className="flex flex-col gap-4" onSubmit={(e) => void onSubmit(e)} noValidate>
          {children}
          <Notice text={error} tone="error" />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              {t('platform.common.cancel')}
            </Button>
            <Button type="submit" disabled={busy} data-testid="form-save">
              {t('platform.common.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Archive behind a confirm dialog; restore right away (restoring loses nothing). `run` sends the
 * write with `archived` set; the caller gives it its own ActionKey.
 */
export function ArchiveToggle({
  archived,
  labels,
  run,
  onDone,
}: {
  archived: boolean;
  labels: { archive: string; unarchive: string; title: string; description: string };
  run: (archived: boolean) => Promise<Result<unknown>>;
  onDone: () => void;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!archived) {
    return (
      <ConfirmAction
        testId="archive"
        trigger={labels.archive}
        title={labels.title}
        description={labels.description}
        confirm={labels.archive}
        run={() => run(true)}
        onDone={onDone}
      />
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <Button
        variant="outline"
        disabled={busy}
        data-testid="unarchive"
        onClick={() => {
          setBusy(true);
          setError(null);
          void run(false).then((result) => {
            setBusy(false);
            if (result.ok) onDone();
            else setError(t(errorLabel(result.code)));
          });
        }}
      >
        {labels.unarchive}
      </Button>
      <Notice text={error} tone="error" />
    </div>
  );
}
