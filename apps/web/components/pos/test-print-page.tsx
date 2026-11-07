'use client';

import type { PrinterSettings } from '@durby/shared';
import type { Ref } from 'react';
import { useT } from '../../app/labels-provider';

/**
 * The test page a printer gets (Settings → Printers, remote test print; ADR 0032): drawn like a bill, at the
 * printer's width, in the location's language. Kept hidden; only its picture is printed.
 */
export function TestPrintPage({
  ref,
  locationName,
  printer,
}: {
  ref: Ref<HTMLDivElement>;
  locationName: string;
  printer: PrinterSettings | null;
}) {
  const t = useT();
  return (
    <div className="hidden" aria-hidden>
      <div ref={ref} className="flex flex-col gap-1 p-2 font-mono text-xs text-foreground">
        <p className="text-base font-bold">{t('pos.printerSettings.testTitle')}</p>
        {locationName && <p>{locationName}</p>}
        {printer && (
          <p>
            {t('pos.printerSettings.testPrinter', { address: `${printer.host}:${printer.port}` })}
          </p>
        )}
        <p>{new Date().toLocaleString()}</p>
        <p>{t('pos.printerSettings.testLine')}</p>
      </div>
    </div>
  );
}
