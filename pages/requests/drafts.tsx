import { useEffect } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '../../components/layout';

/**
 * Drafts now live as a tab on My Requests, keeping every request state in one
 * hub. This route redirects to that tab so existing links/bookmarks still work.
 */
export default function MyDraftsPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace('/requests/my-requests?tab=drafts');
  }, [router]);

  return (
    <AppLayout title="My Drafts">
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-500" />
      </div>
    </AppLayout>
  );
}
