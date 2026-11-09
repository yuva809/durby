'use client';

import type { LabelKey } from '@durby/i18n';
import { type PrepStation, PRINT_JOB_POLL_MS, type PrintJobStatusResponse } from '@durby/shared';
import { useEffect, useState } from 'react';
import { Notice } from '../../app/auth-layout';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { errorLabel } from '../../lib/auth/errors';
import { loadPrintStatus, reprintPrintJob } from '../../lib/pos/print-jobs';
import { ActionKey } from '../../lib/idempotency';
import { Button } from '../ui/button';

/** How often the warnings are read again. */
const REFRESH_MS = 10_000;
/** A till that polled within this long counts as printing (it polls every PRINT_JOB_POLL_MS). */
const TILL_ALIVE_MS = Math.max(30_000, PRINT_JOB_POLL_MS * 10);

const REASONS: Record<string, LabelKey> = {
  'print.printer_unreachable': 'pos.printWarnings.reasonUnreachable',
  'print.paper_out': 'pos.printWarnings.reasonPaperOut',
  'print.cover_open': 'pos.printWarnings.reasonCoverOpen',
};

/**
 * What isn't printing at a location (ADR 0033 §12): jobs waiting without a till, printers being retried, and jobs a
 * person has to look at, with Reprint. On a station's screen (`station`) only its own tickets, with its own
 * permission. Renders nothing while all is well, or where the member can't read it.
 */
export function PrintWarnings({
  locationId,
  station,
  canReprint,
}: {
  locationId: string;
  station?: PrepStation;
  canReprint: boolean;
}) {
  const t = useT();
  const { store } = useAuth();
  // With the moment it was read: "is a till printing" is judged then, not while rendering.
  const [status, setStatus] = useState<(PrintJobStatusResponse & { readAt: number }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let stopped = false;
    const read = async () => {
      if (document.hidden) return;
      const result = await loadPrintStatus(store, locationId, station);
      if (!stopped) setStatus(result.ok ? { ...result.data, readAt: Date.now() } : null);
    };
    void read();
    const timer = setInterval(() => void read(), REFRESH_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [store, locationId, station, tick]);

  if (!status) return null;
  const { waiting, retrying, attention } = status;
  if (waiting.count === 0 && retrying.length === 0 && attention.length === 0) return null;

  const seen = status.tillSeenAt ? Date.parse(status.tillSeenAt) : null;
  const tillAlive = seen !== null && status.readAt - seen < TILL_ALIVE_MS;
  const time = (iso: number) =>
    new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }).format(new Date(iso));

  async function reprint(id: string) {
    setError(null);
    const result = await reprintPrintJob(store, new ActionKey(), id, station);
    if (!result.ok) setError(t(errorLabel(result.code)));
    setTick((n) => n + 1);
  }

  return (
    <div className="flex flex-col gap-2" data-testid="print-warnings" role="status">
      {waiting.count > 0 && (
        <Notice
          tone={tillAlive ? 'info' : 'error'}
          text={
            tillAlive
              ? t('pos.printWarnings.waiting', { count: String(waiting.count) })
              : seen === null
                ? t('pos.printWarnings.noTill', { count: String(waiting.count) })
                : t('pos.printWarnings.noTillSince', {
                    count: String(waiting.count),
                    time: time(seen),
                  })
          }
        />
      )}
      {retrying.map((r) => (
        <Notice
          key={`${r.printerId}:${r.lastCode}`}
          tone="error"
          text={t('pos.printWarnings.retrying', {
            printer: r.printerName,
            reason: t(REASONS[r.lastCode] ?? 'pos.printWarnings.reasonOther'),
          })}
        />
      ))}
      {attention.length > 0 && (
        <div className="flex flex-col gap-2" data-testid="print-attention">
          <p className="text-sm font-semibold">{t('pos.printWarnings.attention')}</p>
          {attention.map((job) => {
            const args = { printer: job.printerName, order: job.orderNumber };
            const text = job.expired
              ? t('pos.printWarnings.expired', args)
              : job.status === 'failed'
                ? t('pos.printWarnings.failed', args)
                : t('pos.printWarnings.maybePrinted', args);
            return (
              <div key={job.id} className="flex flex-wrap items-center gap-2">
                <Notice tone="error" text={text} />
                {canReprint && (
                  <Button
                    variant="outline"
                    onClick={() => void reprint(job.id)}
                    data-testid="print-reprint"
                  >
                    {t('pos.printWarnings.reprint')}
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      )}
      <Notice text={error} tone="error" />
    </div>
  );
}
