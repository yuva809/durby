import { Suspense } from 'react';
import { FloorPage } from '../../../components/pos/floor-page';

// The floor reads its view from the address (useSearchParams), which needs a Suspense boundary.
export default function Page() {
  return (
    <Suspense>
      <FloorPage />
    </Suspense>
  );
}
