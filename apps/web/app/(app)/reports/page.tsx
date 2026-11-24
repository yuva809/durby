import { Suspense } from 'react';
import { SalesReport } from '../../../components/reports/sales-report';

// The page reads its period from the URL (useSearchParams), which needs a Suspense boundary.
export default function Page() {
  return (
    <Suspense>
      <SalesReport />
    </Suspense>
  );
}
