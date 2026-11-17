import { Suspense } from 'react';
import { RequestsPage } from '../../../components/requests/requests-page';

// The page reads ?open= (useSearchParams), which needs a Suspense boundary.
export default function Page() {
  return (
    <Suspense>
      <RequestsPage />
    </Suspense>
  );
}
