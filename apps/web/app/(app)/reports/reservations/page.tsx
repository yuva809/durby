import { Suspense } from 'react';
import { ReservationsReport } from '../../../../components/reports/reservations-report';

// The page reads its period from the URL (useSearchParams), which needs a Suspense boundary.
export default function Page() {
  return (
    <Suspense>
      <ReservationsReport />
    </Suspense>
  );
}
