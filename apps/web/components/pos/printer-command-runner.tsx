'use client';

import { PRINTER_COMMAND_POLL_MS, type Printer } from '@durby/shared';
import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useAuth } from '../../app/providers';
import { loadBillLayout } from '../../lib/pos/api';
import { pollPrinterCommands } from '../../lib/pos/printer-commands';
import { renderBillImage } from '../../lib/print/bill-image';
import { loadDeviceSettings, useDeviceSettings } from '../../lib/print/device-settings';
import { nativePrinter } from '../../lib/print/native';
import { setTillLocation } from '../../lib/print/till-location';
import { TestPrintPage } from './test-print-page';

/**
 * Remote printer commands on the till (ADR 0032 §15): while this POS page of `locationId` is open inside the
 * Android app on a device that prints, asks every 15 s for that location's open commands and runs them. In a normal browser it renders
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
  // The printer the test page is drawn for: set (and rendered) just before its picture is taken.
  const [testPrinter, setTestPrinter] = useState<Printer | null>(null);
  const inApp = nativePrinter() !== null;
  // A device with "This device prints" off runs no commands either (Settings → This device, app 1.1).
  const device = useDeviceSettings();
  const runs = device.loaded && device.settings.prints;
  useEffect(() => {
    if (nativePrinter()) void loadDeviceSettings();
  }, []);

  // The till prints its print jobs for the location its floor or order page shows (ADR 0033).
  useEffect(() => setTillLocation(locationId), [locationId]);

  useEffect(() => {
    const printer = nativePrinter();
    if (!printer || !runs) return;
    let busy = false;
    let stopped = false;
    const tick = async () => {
      if (busy || stopped || document.hidden) return;
      busy = true;
      try {
        await pollPrinterCommands(store, locationId, {
          printer,
          printerFor: async (printerId) => {
            const layout = await loadBillLayout(store, locationId);
            return layout.ok
              ? (layout.data.printerList.find((p) => p.id === printerId) ?? null)
              : null;
          },
          renderTestPage: (target) => {
            flushSync(() => setTestPrinter(target));
            if (!testPage.current) return Promise.reject(new Error('no test page'));
            return renderBillImage(testPage.current, target.widthDots);
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
  }, [store, locationId, runs]);

  return inApp ? (
    <TestPrintPage ref={testPage} locationName={locationName} printer={testPrinter} />
  ) : null;
}
