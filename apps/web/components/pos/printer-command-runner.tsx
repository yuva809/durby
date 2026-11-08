'use client';

import { PRINTER_COMMAND_POLL_MS } from '@durby/shared';
import { useEffect, useRef } from 'react';
import { useAuth } from '../../app/providers';
import { loadBillLayout } from '../../lib/pos/api';
import { pollPrinterCommands } from '../../lib/pos/printer-commands';
import { renderBillImage } from '../../lib/print/bill-image';
import { nativePrinter } from '../../lib/print/native';
import { TestPrintPage } from './test-print-page';

/**
 * Remote printer commands on the till (ADR 0032 §15): while this POS page of `locationId` is open inside the
 * Android app, asks every 15 s for that location's open commands and runs them. In a normal browser it renders
 * nothing and never polls: there is no print object to run them with.
 */
export function PrinterCommandRunner({
  locationId,
  locationName = '',
}: {
  locationId: string;
  locationName?: string;
}) {
  const { store } = useAuth();
  const testPage = useRef<HTMLDivElement>(null);
  const inApp = nativePrinter() !== null;

  useEffect(() => {
    const printer = nativePrinter();
    if (!printer) return;
    let busy = false;
    let stopped = false;
    const tick = async () => {
      if (busy || stopped || document.hidden) return;
      busy = true;
      try {
        await pollPrinterCommands(store, locationId, {
          printer,
          savedPrinter: async () => {
            const layout = await loadBillLayout(store, locationId);
            return layout.ok ? layout.data.printers.bill : null;
          },
          renderTestPage: (widthDots) => {
            if (!testPage.current) return Promise.reject(new Error('no test page'));
            return renderBillImage(testPage.current, widthDots);
          },
        });
      } finally {
        busy = false;
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), PRINTER_COMMAND_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [store, locationId]);

  return inApp ? <TestPrintPage ref={testPage} locationName={locationName} printer={null} /> : null;
}
