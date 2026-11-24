import { Suspense } from 'react';
import { TablesReport } from '../../../../components/reports/tables-report';

// The page reads its period from the URL (useSearchParams), which needs a Suspense boundary.
export default function Page() {
  return (
    <Suspense>
      <TablesReport />
    </Suspense>
  );
}
