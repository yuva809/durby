import { Suspense } from 'react';
import { FeedbackPage } from '../../../components/feedback/feedback-page';

// The page reads ?from= (useSearchParams), which needs a Suspense boundary.
export default function Page() {
  return (
    <Suspense>
      <FeedbackPage />
    </Suspense>
  );
}
