'use client';

import type { Ref } from 'react';
import { useT } from '../../app/labels-provider';

/** What the test page says about its printer. */
export interface TestPagePrinter {
  name: string;
  host: string;
  port: number;
}

/**
 * The test page a printer gets (Settings → Printers, remote test print; ADR 0032, ADR 0033): drawn like a bill, at
 * the printer's width, in the location's language, with the printer's name and address, so several printers can be
 * told apart from far away. Kept hidden; only its picture is printed.
 */
export function TestPrintPage({
  ref,
  locationName,
  printer,
}: {
  ref: Ref<HTMLDivElement>;
  locationName: string;
  printer: TestPagePrinter | null;
}) {
  const t = useT();
  return (
    <div className="hidden" aria-hidden>
      <div
        ref={ref}
        className="flex flex-col gap-1 p-2 font-mono text-xs text-foreground"
        data-testid="test-print-page"
      >
        <p className="text-base font-bold">
          {printer?.name
            ? t('pos.printerSettings.testTitleNamed', { printer: printer.name })
            : t('pos.printerSettings.testTitle')}
        </p>
        {locationName && <p>{locationName}</p>}
        {printer && (
          <p>
            {t('pos.printerSettings.testPrinter', { address: `${printer.host}:${printer.port}` })}
          </p>
        )}
        <p>{new Date().toLocaleString()}</p>
        <p>{t('pos.printerSettings.testLine')}</p>
        {/* The paper's full width: on too narrow a paper the right end (where bills put prices) is cut off. */}
        <div className="mt-1 flex items-center gap-1 font-bold" data-testid="test-print-edges">
          <span>|&lt;</span>
          <span className="flex-1 border-t-2 border-dashed border-foreground" />
          <span>&gt;|</span>
        </div>
        <p>{t('pos.printerSettings.testEdges')}</p>
      </div>
    </div>
  );
}
