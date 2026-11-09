'use client';

import {
  type BillLayout,
  type Order,
  PRINT_JOB_POLL_MS,
  type Printer,
  type PrintJob,
} from '@durby/shared';
import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useAuth } from '../../app/providers';
import { loadBillLayout } from '../../lib/pos/api';
import { billLines } from '../../lib/pos/format';
import { loadOrder, oneAtATime, pollPrintJobs } from '../../lib/pos/print-jobs';
import { preloadBillRenderer, renderBillImage } from '../../lib/print/bill-image';
import { nativePrinter } from '../../lib/print/native';
import { useTillLocation } from '../../lib/print/till-location';
import { useBrand } from '../theme-provider';
import { KitchenTicketView } from './kitchen-ticket';
import { MoneyProvider } from './money';
import { Receipt } from './receipt';

/** What is drawn for the job being printed. */
type Drawn = { job: PrintJob; order: Order; layout: BillLayout | null } | null;

/** The location's printers and bill layout are read again after this long (a printer switched on or moved). */
const LAYOUT_TTL_MS = 30_000;

/**
 * Print jobs on the till (ADR 0033 §10–12): on every page, while the Android app is open and the signed-in member may
 * print bills, asks every 1.5 s for the till's location's due jobs, claims them (exactly one till wins each), draws
 * each ticket or bill at its printer's width, prints it through the print object and answers; one lane per printer. In a normal browser it
 * renders nothing and never polls.
 */
export function PrintJobRunner() {
  const { session } = useAuth();
  const canPrint =
    (session?.activePermissions.includes('pos.bills.print') ?? false) &&
    (session?.activeFeatures.includes('pos') ?? false);
  if (nativePrinter() === null || !canPrint) return null;
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
    const draw = oneAtATime(async (job: PrintJob, order: Order, widthDots: number) => {
      flushSync(() => setDrawn({ job, order, layout: layout?.data ?? null }));
      if (!page.current) throw new Error('nothing drawn');
      return renderBillImage(page.current, widthDots);
    });
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
            return draw(job, order.data, target.widthDots);
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
