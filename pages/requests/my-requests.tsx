import { useSession } from 'next-auth/react';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import { AppLayout } from '../../components/layout';
import RequestsView from '../../components/requests/RequestsView';
import ArchiveView from '../../components/requests/ArchiveView';
import { ListChecks, Archive, FilePen } from 'lucide-react';

type MyRequestsTab = 'requests' | 'drafts' | 'archives';

/**
 * My Requests — the single hub for everything a user has submitted.
 *
 * "Requests" shows the full lifecycle in well-defined, paginated sections
 * (pending / approved / rejected / cancelled / withdrawn), i.e. both active
 * requests and history. "Archived Documents" holds the signed PDF for every
 * fully-approved request, with on-demand regeneration and one-click delivery
 * to the user's Microsoft 365 (OneDrive + Outlook). This page replaces the
 * former standalone /requests/history page.
 */
export default function MyRequestsPage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const [tab, setTab] = useState<MyRequestsTab>('requests');

  useEffect(() => {
    if (status === 'unauthenticated') router.push('/');
  }, [status, router]);

  // Allow deep-links: /requests/my-requests?tab=archives|drafts (also used by
  // the old /archive, /requests/history and /requests/drafts redirects).
  useEffect(() => {
    if (router.query.tab === 'archives') setTab('archives');
    else if (router.query.tab === 'drafts') setTab('drafts');
    else if (router.query.tab === 'requests') setTab('requests');
  }, [router.query.tab]);

  if (status === 'loading') {
    return (
      <AppLayout title="My Requests">
        <div className="flex items-center justify-center min-h-[60vh]">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-500" />
        </div>
      </AppLayout>
    );
  }

  if (!session) return null;

  const switchTab = (next: MyRequestsTab) => {
    setTab(next);
    router.replace(
      { pathname: '/requests/my-requests', query: next === 'requests' ? {} : { tab: next } },
      undefined,
      { shallow: true }
    );
  };

  return (
    <AppLayout title="My Requests">
      <div className="px-4 sm:px-6 pt-4 max-w-6xl mx-auto">
        <div className="flex gap-2 bg-gray-100 p-1 rounded-xl w-fit">
          <button
            onClick={() => switchTab('requests')}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              tab === 'requests' ? 'bg-white text-brand-600 shadow-sm' : 'text-gray-600 hover:text-gray-900'
            }`}
          >
            <ListChecks className="w-4 h-4" strokeWidth={1.5} />
            Requests
          </button>
          <button
            onClick={() => switchTab('drafts')}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              tab === 'drafts' ? 'bg-white text-brand-600 shadow-sm' : 'text-gray-600 hover:text-gray-900'
            }`}
          >
            <FilePen className="w-4 h-4" strokeWidth={1.5} />
            Drafts
          </button>
          <button
            onClick={() => switchTab('archives')}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              tab === 'archives' ? 'bg-white text-brand-600 shadow-sm' : 'text-gray-600 hover:text-gray-900'
            }`}
          >
            <Archive className="w-4 h-4" strokeWidth={1.5} />
            Archived Documents
          </button>
        </div>
      </div>

      {tab === 'requests' ? (
        <RequestsView mode="tracking" />
      ) : tab === 'drafts' ? (
        <RequestsView mode="drafts" />
      ) : (
        <div className="p-4 sm:p-6 max-w-6xl mx-auto">
          <ArchiveView />
        </div>
      )}
    </AppLayout>
  );
}
