'use client';

import {
  type BillLayout,
  type GuestCheck,
  type Order,
  PRINT_JOB_POLL_MS,
  type Printer,
  type PrintJob,
} from '@durby/shared';
import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useAuth } from '../../app/providers';
import { loadBillLayout } from '../../lib/pos/api';
import { loadCheck } from '../../lib/pos/bills';
import { billLines } from '../../lib/pos/format';
import { loadOrder, oneAtATime, pollPrintJobs } from '../../lib/pos/print-jobs';
import { preloadBillRenderer, renderBillImage } from '../../lib/print/bill-image';
import { loadDeviceSettings, useDeviceSettings } from '../../lib/print/device-settings';
import { nativePrinter } from '../../lib/print/native';
import { useTillLocation } from '../../lib/print/till-location';
import { useBrand } from '../theme-provider';
import { KitchenTicketView } from './kitchen-ticket';
import { MoneyProvider } from './money';
import { CheckReceipt } from './check-receipt';
import { Receipt } from './receipt';

/** What is drawn for the job being printed. */
type Drawn = {
  job: PrintJob;
  order: Order;
  /** The guest check a bill job prints (ADR 0036); null: the bill is drawn from the order. */
  check: GuestCheck | null;
  layout: BillLayout | null;
} | null;

/** The location's printers and bill layout are read again after this long (a printer switched on or moved). */
const LAYOUT_TTL_MS = 30_000;

/**
 * Print jobs on the till (ADR 0033 §10–12): on every page, while the Android app is open, "This device prints" is on
 * (Settings → This device, app 1.1) and the signed-in member may print bills, asks every 1.5 s for the till's location's due jobs, claims them (exactly one till wins each), draws
 * each ticket or bill at its printer's width, prints it through the print object and answers; one lane per printer. In a normal browser it
 * renders nothing and never polls.
 */
export function PrintJobRunner() {
  const { session } = useAuth();
  const canPrint =
    (session?.activePermissions.includes('pos.bills.print') ?? false) &&
    (session?.activeFeatures.includes('pos') ?? false);
  const device = useDeviceSettings();
  useEffect(() => {
    if (nativePrinter()) void loadDeviceSettings();
  }, []);
  if (nativePrinter() === null || !canPrint) return null;
  // Read from the app first: a device switched to "doesn't print" never polls, not even once.
  if (!device.loaded || !device.settings.prints) return null;
  // Bills print in the organization's currency: its settings load once, before the first job.
  return (
    <MoneyProvider>
      <Runner />
    </MoneyProvider>
  );
}

function Runner() {
  const { store, session } = useAuth();
  const { productName } = useBrand();
  const locationId = useTillLocation();
  const page = useRef<HTMLDivElement>(null);
  const [drawn, setDrawn] = useState<Drawn>(null);
  const organizationName =
    session?.organizations.find((o) => o.id === session.activeOrganizationId)?.name ?? '';

  useEffect(() => {
    const printer = nativePrinter();
    if (!printer || !locationId) return;
    let busy = false;
    let stopped = false;
    let layout: { at: number; data: BillLayout } | null = null;
    const currentLayout = async (fresh = false) => {
      if (!fresh && layout && Date.now() - layout.at < LAYOUT_TTL_MS) return layout.data;
      const read = await loadBillLayout(store, locationId);
      layout = read.ok ? { at: Date.now(), data: read.data } : layout;
      return layout?.data ?? null;
    };
    // One hidden page: jobs for different printers print at the same time, but are drawn one after another.
    const draw = oneAtATime(
      async (job: PrintJob, order: Order, check: GuestCheck | null, widthDots: number) => {
        flushSync(() => setDrawn({ job, order, check, layout: layout?.data ?? null }));
        if (!page.current) throw new Error('nothing drawn');
        return renderBillImage(page.current, widthDots);
      },
    );
    const tick = async () => {
      if (busy || stopped) return;
      busy = true;
      try {
        await pollPrintJobs(store, locationId, {
          printer,
          printerFor: async (printerId: string): Promise<Printer | null> => {
            const find = (l: BillLayout | null) => l?.printerList.find((p) => p.id === printerId);
            return find(await currentLayout()) ?? find(await currentLayout(true)) ?? null;
          },
          render: async (job, target) => {
            const order = await loadOrder(store, job.orderId);
            if (!order.ok) throw new Error('order not readable');
            const check = job.checkId ? await loadCheck(store, job.checkId) : null;
            if (check && !check.ok) throw new Error('check not readable');
            return draw(job, order.data, check?.data ?? null, target.widthDots);
          },
        });
      } finally {
        busy = false;
      }
    };
    // Ready before the first job: the converter loaded and the location's printers read.
    void preloadBillRenderer().catch(() => undefined);
    void currentLayout();
    void tick();
    const timer = setInterval(() => void tick(), PRINT_JOB_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [store, locationId]);

  if (!drawn) return null;
  const { job, order } = drawn;
  const ticket = job.ticketId ? order.tickets.find((x) => x.id === job.ticketId) : null;
  return (
    <div className="hidden" aria-hidden data-testid="print-job-page">
      <div ref={page}>
        {job.kind === 'ticket' && ticket ? (
          <KitchenTicketView
            ticket={ticket}
            tableName={order.tableName}
            orderNumber={order.number}
            organizationName={organizationName}
          />
        ) : job.kind === 'bill' && drawn.check ? (
          <CheckReceipt
            check={drawn.check}
            layout={drawn.layout}
            organizationName={organizationName}
            productName={productName}
            printedAt={new Date()}
          />
        ) : job.kind === 'bill' ? (
          <Receipt
            layout={drawn.layout}
            organizationName={organizationName}
            productName={productName}
            tableName={order.tableName}
            order={{
              number: order.number,
              covers: order.covers,
              waiterName: order.waiterName,
              total: order.totals.gross,
            }}
            bill={billLines(order)}
            printedAt={new Date()}
          />
        ) : null}
      </div>
    </div>
  );
}
