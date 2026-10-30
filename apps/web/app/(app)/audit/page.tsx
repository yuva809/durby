import { Suspense } from 'react';
import { AuditPage } from '../../../components/audit/audit-page';

// The page reads its filters from the URL (useSearchParams), which needs a Suspense boundary.
export default function Page() {
  return (
    <Suspense>
      <AuditPage />
    </Suspense>
  );
}
