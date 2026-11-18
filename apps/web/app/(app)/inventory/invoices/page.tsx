import { Suspense } from 'react';
import { InvoiceQueuePage } from '../../../../components/inventory/invoice-queue-page';

/** The vendor invoice approval queue (ADR 0051); `?open=` opens one (search params need Suspense). */
export default function Page() {
  return (
    <Suspense>
      <InvoiceQueuePage />
    </Suspense>
  );
}
