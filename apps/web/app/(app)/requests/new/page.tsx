import { Suspense } from 'react';
import { RequestStockPage } from '../../../../components/requests/request-stock-page';

// The page reads ?cart=1 (useSearchParams), which needs a Suspense boundary.
export default function Page() {
  return (
    <Suspense>
      <RequestStockPage />
    </Suspense>
  );
}
