'use client';

import type { DiningTable } from '@durby/shared';
import { Printer, QrCode, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Notice } from '../../app/auth-layout';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { errorLabel } from '../../lib/auth/errors';
import { renewMenuCode } from '../../lib/pos/api';
import { printAs } from '../../lib/pos/print';
import { menuUrl, qrDataUrl } from '../../lib/pos/qr';
import { useActionKey } from '../../lib/use-action-key';
import { PrintRoot } from '../pos/kitchen-ticket';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  DialogTrigger,
} from '../ui/dialog';

/**
 * A table's QR code for guests (docs/modules/pos.md → QR menu, ADR 0026): the code, its link, a
 * print card for the table and, for table managers, a new code that retires the old one.
 */
export function QrDialog({
  table,
  canManage,
  onDone,
}: {
  table: DiningTable;
  canManage: boolean;
  onDone: () => void;
}) {
  const t = useT();
  const { store, session } = useAuth();
  const action = useActionKey();
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState(table.menuCode);
  const [image, setImage] = useState<string | null>(null);
  const [printing, setPrinting] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const organizationName =
    session?.organizations.find((o) => o.id === session.activeOrganizationId)?.name ?? '';
  const url =
    typeof window === 'undefined' || !session?.activeOrganizationId
      ? ''
      : menuUrl(window.location.origin, session.activeOrganizationId, code);

  useEffect(() => {
    if (!open || !url) return;
    let current = true;
    void qrDataUrl(url).then((next) => {
      if (current) setImage(next);
    });
    return () => {
      current = false;
    };
  }, [open, url]);

  useEffect(() => {
    if (printing > 0) printAs(organizationName);
  }, [printing, organizationName]);

  async function renew() {
    setBusy(true);
    setError(null);
    const result = await renewMenuCode(store, action, table.id);
    setBusy(false);
    if (result.ok && result.data) {
      setCode(result.data.menuCode);
      onDone();
    } else if (!result.ok) {
      setError(t(errorLabel(result.code)));
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          aria-label={t('pos.qr.open', { name: table.name })}
          data-testid="table-qr"
        >
          <QrCode aria-hidden className="size-4" />
        </Button>
      </DialogTrigger>
      <DialogContent closeLabel={t('platform.common.close')} className="max-w-sm">
        <DialogTitle>{t('pos.qr.title', { name: table.name })}</DialogTitle>
        <DialogDescription>{t('pos.qr.description')}</DialogDescription>
        <div className="flex flex-col items-center gap-3">
          {image && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={image}
              alt={t('pos.qr.alt', { name: table.name })}
              className="size-56 rounded-md border border-border bg-card p-2"
              data-testid="qr-image"
            />
          )}
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="max-w-full text-sm break-all"
            data-testid="qr-url"
          >
            {url}
          </a>
          <Notice text={error} tone="error" />
        </div>
        <DialogFooter className="flex-wrap gap-2">
          {canManage && (
            <Button
              variant="outline"
              className="gap-2"
              disabled={busy}
              onClick={() => void renew()}
              data-testid="qr-renew"
            >
              <RefreshCw aria-hidden />
              {t('pos.qr.renew')}
            </Button>
          )}
          <Button
            className="gap-2"
            disabled={!image}
            onClick={() => setPrinting((n) => n + 1)}
            data-testid="qr-print"
          >
            <Printer aria-hidden />
            {t('pos.qr.print')}
          </Button>
        </DialogFooter>
        {canManage && <p className="text-xs text-muted-foreground">{t('pos.qr.renewHint')}</p>}
        {printing > 0 && image && (
          <PrintRoot>
            <article
              key={printing}
              className="flex flex-col items-center gap-2 p-4 text-center font-sans text-foreground"
              data-testid="qr-card"
            >
              <p className="text-lg font-bold">{organizationName}</p>
              <p className="text-base">{t('pos.qr.scan')}</p>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={image} alt="" className="w-[60mm]" />
              <p className="text-2xl font-bold">{t('pos.ticket.table', { table: table.name })}</p>
            </article>
          </PrintRoot>
        )}
      </DialogContent>
    </Dialog>
  );
}
