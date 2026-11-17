import { Suspense } from 'react';
import { OrdersPage } from '../../../components/orders/orders-page';

// The page reads ?open= (useSearchParams), which needs a Suspense boundary.
export default function Page() {
  return (
    <Suspense>
      <OrdersPage />
    </Suspense>
  );
}
