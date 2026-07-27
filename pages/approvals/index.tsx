import { useSession } from 'next-auth/react';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import { GetServerSideProps } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '../api/auth/[...nextauth]';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getWatchedOwnerIds } from '@/lib/permanentWatchers';
import { parseAmount } from '@/lib/money';
import dynamic from 'next/dynamic';
import { AppLayout } from '../../components/layout';
import Loader from '@/components/Loader';
import { Card, Button } from '../../components/ui';
import { useApprovals } from '../../hooks';
import tickAnimation from '../../tick.json';
import criticalAnimation from '../../lotties/red critical.json';
import urgentAnimation from '../../lotties/orange warning exclamation.json';

const Lottie = dynamic(() => import('lottie-react'), { ssr: false });

const pulseKeyframes = `
@keyframes pulse-red {
  0%, 100% {
    box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.4), 0 10px 25px -5px rgba(239, 68, 68, 0.3);
    border-color: rgb(252, 165, 165);
  }
  50% {
    box-shadow: 0 0 0 8px rgba(239, 68, 68, 0), 0 20px 35px -5px rgba(239, 68, 68, 0.4);
    border-color: rgb(239, 68, 68);
  }
}

@keyframes pulse-orange {
  0%, 100% {
    box-shadow: 0 0 0 0 rgba(249, 115, 22, 0.4), 0 10px 25px -5px rgba(249, 115, 22, 0.3);
    border-color: rgb(253, 186, 116);
  }
  50% {
    box-shadow: 0 0 0 8px rgba(249, 115, 22, 0), 0 20px 35px -5px rgba(249, 115, 22, 0.4);
    border-color: rgb(249, 115, 22);
  }
}
`;

const CRITICAL_ANIMATION_DURATION = 1.4;
const HIGH_ANIMATION_DURATION = 4.17;

function getRequestDetailPath(request: any): string {
  const requestType = request.metadata?.type || request.metadata?.requestType;
  if (requestType === 'hotel_booking' || requestType === 'voucher_request') {
    return `/requests/comp/${request.id}`;
  }
  return `/requests/${request.id}`;
}

// Humanise a duration in ms as e.g. "3h", "2d 4h", "45m".
function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${Math.max(mins, 1)}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) {
    const rem = mins % 60;
    return rem ? `${hours}h ${rem}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const remH = hours % 24;
  return remH ? `${days}d ${remH}h` : `${days}d`;
}

const statusConfig: Record<string, { label: string; bg: string; text: string }> = {
  pending: { label: 'Pending', bg: 'bg-yellow-100', text: 'text-yellow-800' },
  pending_approval: { label: 'Pending', bg: 'bg-yellow-100', text: 'text-yellow-800' },
  in_review: { label: 'In Review', bg: 'bg-[#F3EADC]', text: 'text-[#3F2D19]' },
  approved: { label: 'Approved', bg: 'bg-green-100', text: 'text-green-800' },
  rejected: { label: 'Rejected', bg: 'bg-red-100', text: 'text-red-800' },
  completed: { label: 'Completed', bg: 'bg-green-100', text: 'text-green-800' },
};

const priorityConfig: Record<string, { label: string; bg: string; text: string; border: string }> = {
  critical: { label: 'Critical', bg: 'bg-red-50', text: 'text-red-700', border: 'border-red-200' },
  high: { label: 'High', bg: 'bg-orange-50', text: 'text-orange-700', border: 'border-orange-200' },
  urgent: { label: 'Urgent', bg: 'bg-red-50', text: 'text-red-600', border: 'border-red-200' },
  medium: { label: 'Medium', bg: 'bg-[#F3EADC]', text: 'text-[#9A7545]', border: 'border-[#C9B896]' },
  normal: { label: 'Normal', bg: 'bg-[#F3EADC]', text: 'text-[#9A7545]', border: 'border-[#C9B896]' },
  low: { label: 'Low', bg: 'bg-gray-50', text: 'text-gray-600', border: 'border-gray-200' },
};

type TabType = 'pending' | 'watching' | 'history';

interface ApprovalsPageProps {
  initialPendingApprovals: any[];
  initialWatchingRequests: any[];
  initialHistoryRequests: any[];
  initialError: string | null;
}

export const getServerSideProps: GetServerSideProps<ApprovalsPageProps> = async (context) => {
  const session = await getServerSession(context.req, context.res, authOptions);

  if (!session?.user?.id) {
    return {
      redirect: {
        destination: '/',
        permanent: false,
      },
    };
  }

  const userId = session.user.id;
  const organizationId = (session.user as any).org_id;

  try {
    // Fetch pending approvals for current user
    const { data: pendingSteps, error: stepsError } = await supabaseAdmin
      .from('request_steps')
      .select('request_id, approver_user_id')
      .eq('approver_user_id', userId)
      .eq('status', 'pending');

    let pendingApprovals: any[] = [];
    if (!stepsError && pendingSteps && pendingSteps.length > 0) {
      const requestIds = [...new Set(pendingSteps.map(s => s.request_id))];
      const { data: pendingData, error: fetchError } = await supabaseAdmin
        .from('requests')
        .select(`
          id,
          organization_id,
          workspace_id,
          creator_id,
          title,
          description,
          status,
          metadata,
          created_at,
          updated_at,
          creator:app_users!requests_creator_id_fkey (
            id,
            display_name,
            email,
            profile_picture_url
          ),
          request_steps (
            id,
            step_index,
            step_type,
            approver_role,
            approver_user_id,
            status,
            due_at,
            created_at,
            activated_at,
            first_viewed_at
          ),
          documents ( count )
        `)
        .in('id', requestIds)
        .in('status', ['pending', 'pending_approval'])
        .order('created_at', { ascending: false });

      if (!fetchError && pendingData) {
        pendingApprovals = pendingData.filter((req: any) => {
          const userStep = req.request_steps?.find(
            (step: any) => step.approver_user_id === userId && step.status === 'pending'
          );
          return !!userStep;
        });
      }
    }

    // Fetch watching requests
    const { data: watchingData, error: watchingError } = await supabaseAdmin
      .from('requests')
      .select(`
        id,
        organization_id,
        workspace_id,
        creator_id,
        title,
        description,
        status,
        metadata,
        created_at,
        updated_at,
        creator:app_users!requests_creator_id_fkey (
          id,
          display_name,
          email,
          profile_picture_url
        ),
        request_steps (
          id,
          step_index,
          step_type,
          approver_role,
          approver_user_id,
          status,
          due_at,
          created_at,
          activated_at,
          first_viewed_at
        ),
        documents ( count )
      `)
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: false });

    // Owners who named me as their PERMANENT watcher — I see everything they
    // post or are an approver on. Mirrors /api/approvals/watching so the tab is
    // populated on first server render, not only after the client refetch.
    const watchedOwnerIds = new Set(
      organizationId ? await getWatchedOwnerIds(userId, organizationId) : []
    );

    let watchingRequests: any[] = [];
    if (!watchingError && watchingData) {
      watchingRequests = watchingData.filter((req: any) => {
        const watchers = req.metadata?.watchers || [];
        const isPerRequestWatcher = Array.isArray(watchers) && watchers.some((w: any) =>
          typeof w === 'string' ? w === userId : w?.id === userId
        );
        const isPermanent =
          watchedOwnerIds.size > 0 &&
          ((req.creator_id && watchedOwnerIds.has(req.creator_id)) ||
            (req.request_steps || []).some((s: any) => s.approver_user_id && watchedOwnerIds.has(s.approver_user_id)));
        return isPerRequestWatcher || isPermanent;
      });
    }

    // Fetch history requests
    const { data: historyData, error: historyError } = await supabaseAdmin
      .from('approvals')
      .select(`
        id,
        decision,
        comment,
        signed_at,
        step:request_steps!inner (
          request:requests!inner (
            id,
            organization_id,
            workspace_id,
            creator_id,
            title,
            description,
            status,
            metadata,
            created_at,
            updated_at,
            creator:app_users!requests_creator_id_fkey (
              id,
              display_name,
              email,
              profile_picture_url
            ),
            request_steps (
              id,
              step_index,
              step_type,
              approver_role,
              approver_user_id,
              status,
              due_at
            )
          )
        )
      `)
      .eq('approver_id', userId)
      .order('signed_at', { ascending: false });

    let historyRequests: any[] = [];
    if (!historyError && historyData) {
      historyRequests = historyData.map((approval: any) => ({
        ...approval.step.request,
        user_action: approval.decision,
        user_action_date: approval.signed_at,
        user_comment: approval.comment,
      }));
    }

    return {
      props: {
        initialPendingApprovals: pendingApprovals,
        initialWatchingRequests: watchingRequests,
        initialHistoryRequests: historyRequests,
        initialError: null,
      },
    };
  } catch (err: any) {
    return {
      props: {
        initialPendingApprovals: [],
        initialWatchingRequests: [],
        initialHistoryRequests: [],
        initialError: err.message || 'Failed to load approvals',
      },
    };
  }
};

export default function ApprovalsPage({ initialPendingApprovals, initialWatchingRequests, initialHistoryRequests, initialError }: ApprovalsPageProps) {
  const { data: session, status } = useSession();
  const router = useRouter();
  const { pendingApprovals, watchingRequests, historyRequests, loading, watchingLoading, historyLoading, error } = useApprovals();
  const [activeTab, setActiveTab] = useState<TabType>('pending');
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [priorityFilter, setPriorityFilter] = useState<string>('all');
  const [dateFilter, setDateFilter] = useState<string>('all');
  const [showFilters, setShowFilters] = useState(false);

  // Use initial data from SSR
  const displayPendingApprovals = initialPendingApprovals.length > 0 || loading ? pendingApprovals : initialPendingApprovals;
  const displayWatchingRequests = initialWatchingRequests.length > 0 || watchingLoading ? watchingRequests : initialWatchingRequests;
  const displayHistoryRequests = initialHistoryRequests.length > 0 || historyLoading ? historyRequests : initialHistoryRequests;

  useEffect(() => {
    if (status === 'unauthenticated') {
      router.push('/');
    }
  }, [status, router]);

  const getActiveData = () => {
    switch (activeTab) {
      case 'pending': return displayPendingApprovals;
      case 'watching': return displayWatchingRequests;
      case 'history': return displayHistoryRequests;
      default: return [];
    }
  };

  const activeData = getActiveData();

  const filteredData = activeData.filter((request) => {
    const matchesSearch = 
      request.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (request.description?.toLowerCase().includes(searchQuery.toLowerCase()) ?? false);
    
    const matchesStatus = statusFilter === 'all' || request.status === statusFilter;
    
    const priority = request.metadata?.priority || 'normal';
    const matchesPriority = priorityFilter === 'all' || priority === priorityFilter;
    
    let matchesDate = true;
    if (dateFilter !== 'all') {
      const createdDate = new Date(request.created_at);
      const now = new Date();
      const diffDays = Math.floor((now.getTime() - createdDate.getTime()) / (1000 * 60 * 60 * 24));
      
      if (dateFilter === 'today') matchesDate = diffDays === 0;
      else if (dateFilter === 'week') matchesDate = diffDays <= 7;
      else if (dateFilter === 'month') matchesDate = diffDays <= 30;
    }
    
    return matchesSearch && matchesStatus && matchesPriority && matchesDate;
  });

  const activeFiltersCount = [statusFilter, priorityFilter, dateFilter].filter(f => f !== 'all').length;

  const clearAllFilters = () => {
    setSearchQuery('');
    setStatusFilter('all');
    setPriorityFilter('all');
    setDateFilter('all');
  };

  const isTabLoading = () => {
    switch (activeTab) {
      case 'pending': return loading;
      case 'watching': return watchingLoading;
      case 'history': return historyLoading;
      default: return false;
    }
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) {
      return 'Today';
    } else if (diffDays === 1) {
      return 'Yesterday';
    } else if (diffDays < 7) {
      return `${diffDays} days ago`;
    } else {
      return date.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
    }
  };

  const getDueStatus = (dueAt: string | null) => {
    if (!dueAt) return null;
    const due = new Date(dueAt);
    const now = new Date();
    const diffMs = due.getTime() - now.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays < 0) {
      return { label: 'Overdue', className: 'text-red-600 bg-red-50' };
    } else if (diffDays === 0) {
      return { label: 'Due today', className: 'text-yellow-600 bg-yellow-50' };
    } else if (diffDays === 1) {
      return { label: 'Due tomorrow', className: 'text-yellow-600 bg-yellow-50' };
    } else if (diffDays <= 3) {
      return { label: `Due in ${diffDays} days`, className: 'text-[#9A7545] bg-[#F3EADC]' };
    }
    return null;
  };

  if (status === 'loading' || loading) {
    return (
      <AppLayout title="Approvals">
        <Loader fullScreen={false} />
      </AppLayout>
    );
  }

  if (!session) {
    return null;
  }

  const tabs: { id: TabType; label: string; count?: number; icon: JSX.Element }[] = [
    {
      id: 'pending',
      label: 'Pending',
      count: displayPendingApprovals.length,
      icon: (
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      ),
    },
    {
      id: 'watching',
      label: 'Watching',
      count: displayWatchingRequests.length,
      icon: (
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
        </svg>
      ),
    },
    {
      id: 'history',
      label: 'History',
      count: displayHistoryRequests.length,
      icon: (
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      ),
    },
  ];


  const getTabDescription = () => {
    switch (activeTab) {
      case 'pending': return 'Requests waiting for your approval';
      case 'watching': return 'Requests you are watching';
      case 'history': return 'Your past approval actions';
      default: return '';
    }
  };

  const getEmptyMessage = () => {
    if (searchQuery || activeFiltersCount > 0) {
      return 'No requests match your filters';
    }
    switch (activeTab) {
      case 'pending': return 'No pending approvals at the moment';
      case 'watching': return 'You are not watching any requests';
      case 'history': return 'No approval history yet';
      default: return 'No requests found';
    }
  };

  return (
    <AppLayout title="Approvals">
      <style dangerouslySetInnerHTML={{ __html: pulseKeyframes }} />
      <div className="p-4 sm:p-6 max-w-6xl mx-auto">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 font-heading">Approvals</h1>
            <p className="text-gray-500 mt-1">{getTabDescription()}</p>
          </div>
        </div>

        {/* Tabs */}
        <div className="mb-6">
          <div className="border-b border-gray-200">
            <nav className="-mb-px flex space-x-6 overflow-x-auto" aria-label="Tabs">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => {
                    setActiveTab(tab.id);
                    clearAllFilters();
                  }}
                  className={`flex items-center gap-2 py-3 px-1 border-b-2 font-medium text-sm whitespace-nowrap transition-colors ${
                    activeTab === tab.id
                      ? 'border-brand-500 text-brand-600'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                  }`}
                >
                  {tab.icon}
                  {tab.label}
                  {tab.count !== undefined && (
                    <span className={`ml-1 px-2 py-0.5 rounded-full text-xs font-medium ${
                      activeTab === tab.id
                        ? 'bg-brand-100 text-brand-700'
                        : 'bg-gray-100 text-gray-600'
                    }`}>
                      {tab.count}
                    </span>
                  )}
                </button>
              ))}
            </nav>
          </div>
        </div>

        {/* Error State */}
        {error && (
          <Card className="bg-red-50 border-red-200 mb-6">
            <div className="flex items-center gap-3">
              <svg className="w-5 h-5 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <p className="text-red-600 text-sm">Error loading approvals: {error.message}</p>
            </div>
          </Card>
        )}

        {/* Search and Filters */}
        <div className="mb-6 space-y-4">
          {/* Search Bar Row */}
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                type="text"
                placeholder="Search by title or description..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-gray-300 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent"
              />
            </div>
            <button
              onClick={() => setShowFilters(!showFilters)}
              className={`flex items-center gap-2 px-4 py-2.5 rounded-xl border transition-colors ${
                showFilters || activeFiltersCount > 0
                  ? 'bg-brand-50 border-brand-300 text-brand-700'
                  : 'bg-white border-gray-300 text-gray-700 hover:bg-gray-50'
              }`}
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
              </svg>
              <span className="font-medium">Filters</span>
              {activeFiltersCount > 0 && (
                <span className="bg-brand-500 text-white text-xs font-bold px-2 py-0.5 rounded-full">
                  {activeFiltersCount}
                </span>
              )}
            </button>
          </div>

          {/* Filter Options */}
          {showFilters && (
            <div className="bg-gray-50 rounded-xl p-4 border border-gray-200 space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                {/* Status Filter */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">Status</label>
                  <select
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-gray-300 bg-white focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent text-sm"
                  >
                    <option value="all">All Statuses</option>
                    <option value="pending">Pending</option>
                    <option value="in_review">In Review</option>
                  </select>
                </div>

                {/* Priority Filter */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">Priority</label>
                  <select
                    value={priorityFilter}
                    onChange={(e) => setPriorityFilter(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-gray-300 bg-white focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent text-sm"
                  >
                    <option value="all">All Priorities</option>
                    <option value="urgent">Urgent</option>
                    <option value="high">High</option>
                    <option value="normal">Normal</option>
                    <option value="low">Low</option>
                  </select>
                </div>

                {/* Date Filter */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">Submitted</label>
                  <select
                    value={dateFilter}
                    onChange={(e) => setDateFilter(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-gray-300 bg-white focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent text-sm"
                  >
                    <option value="all">Any Time</option>
                    <option value="today">Today</option>
                    <option value="week">Last 7 Days</option>
                    <option value="month">Last 30 Days</option>
                  </select>
                </div>
              </div>

              {/* Clear Filters */}
              {activeFiltersCount > 0 && (
                <div className="flex justify-end">
                  <button
                    onClick={clearAllFilters}
                    className="text-sm text-gray-600 hover:text-gray-900 font-medium flex items-center gap-1"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                    Clear all filters
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Active Filters Tags */}
          {activeFiltersCount > 0 && !showFilters && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-gray-500">Active filters:</span>
              {statusFilter !== 'all' && (
                <span className="inline-flex items-center gap-1 px-2.5 py-1 bg-brand-50 text-brand-700 rounded-full text-xs font-medium">
                  Status: {statusConfig[statusFilter]?.label || statusFilter}
                  <button onClick={() => setStatusFilter('all')} className="hover:text-brand-900">
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </span>
              )}
              {priorityFilter !== 'all' && (
                <span className="inline-flex items-center gap-1 px-2.5 py-1 bg-brand-50 text-brand-700 rounded-full text-xs font-medium">
                  Priority: {priorityFilter.charAt(0).toUpperCase() + priorityFilter.slice(1)}
                  <button onClick={() => setPriorityFilter('all')} className="hover:text-brand-900">
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </span>
              )}
              {dateFilter !== 'all' && (
                <span className="inline-flex items-center gap-1 px-2.5 py-1 bg-brand-50 text-brand-700 rounded-full text-xs font-medium">
                  Date: {dateFilter === 'today' ? 'Today' : dateFilter === 'week' ? 'Last 7 Days' : 'Last 30 Days'}
                  <button onClick={() => setDateFilter('all')} className="hover:text-brand-900">
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </span>
              )}
              <button
                onClick={clearAllFilters}
                className="text-xs text-gray-500 hover:text-gray-700 underline"
              >
                Clear all
              </button>
            </div>
          )}

          {/* Results Count */}
          {(searchQuery || activeFiltersCount > 0) && (
            <p className="text-sm text-gray-500">
              Showing {filteredData.length} of {activeData.length} request{activeData.length !== 1 ? 's' : ''}
            </p>
          )}
        </div>

        {/* Loading State for Tab */}
        {isTabLoading() ? (
          <Loader fullScreen={false} size={120} />
        ) : filteredData.length === 0 && !error ? (
          /* Empty State */
          <Card className="text-center py-12">
            <div className="w-20 h-20 mx-auto mb-4">
              <Lottie
                animationData={tickAnimation}
                loop={false}
                className="w-full h-full"
              />
            </div>
            <h3 className="text-lg font-medium text-gray-900 mb-1">All caught up!</h3>
            <p className="text-gray-500">
              {getEmptyMessage()}
            </p>
            {(searchQuery || activeFiltersCount > 0) && (
              <Button
                variant="ghost"
                className="mt-4"
                onClick={clearAllFilters}
              >
                Clear filters
              </Button>
            )}
          </Card>
        ) : (
          <div className="space-y-4">
              {filteredData.map((request: any) => {
                const currentStep = request.request_steps?.[0];
                const dueStatus = currentStep?.due_at ? getDueStatus(currentStep.due_at) : null;
                const statusInfo = statusConfig[request.status] || statusConfig.pending;
                const userAction = request.user_action;
                const priority = request.metadata?.priority || 'normal';
                const priorityInfo = priorityConfig[priority] || priorityConfig.normal;
                const creator = Array.isArray(request.creator) ? request.creator[0] : request.creator;
                const creatorName = creator?.display_name || creator?.email?.split('@')[0] || 'Unknown';
                const creatorInitial = creatorName.charAt(0).toUpperCase();
                const profilePhoto = creator?.profile_picture_url;
                // Urgency cues (pulsing border + animation) should only run while the
                // request still needs action — never on resolved/approved requests.
                const isResolved = ['approved', 'rejected', 'withdrawn', 'cancelled', 'completed'].includes(request.status);
                const isCritical = priority === 'critical' && !isResolved;
                const isHighUrgent = priority === 'high' && !isResolved;
                const amount = request.metadata?.amount || request.metadata?.total_amount;
                const currency = request.metadata?.currency || '$';

                // How long the request has been on the current approver's desk, and
                // how many supporting documents it carries.
                const pendingStep = request.request_steps?.find((s: any) => s.status === 'pending') || currentStep;
                const receivedAt = pendingStep?.activated_at || pendingStep?.created_at || null;
                const waitingMs = receivedAt ? Date.now() - new Date(receivedAt).getTime() : null;
                const waitingOverdue = waitingMs != null && waitingMs > 24 * 60 * 60 * 1000;
                const attachmentCount = Array.isArray(request.documents)
                  ? (request.documents[0]?.count ?? request.documents.length ?? 0)
                  : (request.documents?.count ?? 0);

                return (
                  <div
                    key={request.id}
                    onClick={() => router.push(getRequestDetailPath(request))}
                    className={`relative bg-white rounded-2xl border-2 p-5 cursor-pointer transition-all duration-300 hover:-translate-y-1 ${
                      isCritical 
                        ? 'border-red-300' 
                        : isHighUrgent 
                          ? 'border-orange-300'
                          : 'border-gray-100 hover:border-brand-200 hover:shadow-xl'
                    }`}
                    style={
                      isCritical 
                        ? { animation: `pulse-red ${CRITICAL_ANIMATION_DURATION}s ease-in-out infinite` }
                        : isHighUrgent 
                          ? { animation: `pulse-orange ${HIGH_ANIMATION_DURATION}s ease-in-out infinite` }
                          : undefined
                    }
                  >
                    {/* Priority Animation Indicator */}
                    {(isCritical || isHighUrgent) && (
                      <div className="absolute -top-3 -right-3 w-12 h-12">
                        <Lottie
                          animationData={isCritical ? criticalAnimation : urgentAnimation}
                          loop={true}
                          className="w-full h-full"
                        />
                      </div>
                    )}

                    <div className="flex items-start gap-4">
                      {/* Creator Profile Photo */}
                      <div className="flex-shrink-0">
                        {profilePhoto ? (
                          <img
                            src={profilePhoto}
                            alt={creatorName}
                            className="w-14 h-14 rounded-2xl object-cover ring-2 ring-white shadow-md"
                          />
                        ) : (
                          <div className={`w-14 h-14 rounded-2xl flex items-center justify-center text-xl font-bold shadow-md ${
                            isCritical 
                              ? 'bg-gradient-to-br from-red-400 to-red-600 text-white'
                              : isHighUrgent
                                ? 'bg-gradient-to-br from-orange-400 to-orange-600 text-white'
                                : 'bg-gradient-to-br from-brand-400 to-brand-600 text-white'
                          }`}>
                            {creatorInitial}
                          </div>
                        )}
                      </div>

                      {/* Content */}
                      <div className="flex-1 min-w-0">
                        {/* Header Row */}
                        <div className="flex items-start justify-between gap-3 mb-2">
                          <div className="min-w-0">
                            <h3 className="font-semibold text-gray-900 text-lg truncate group-hover:text-brand-600">
                              {request.title}
                            </h3>
                            <div className="flex items-center gap-2 mt-1">
                              <span className="text-sm text-gray-600 font-medium">{creatorName}</span>
                              <span className="w-1 h-1 rounded-full bg-gray-300" />
                              <span className="text-sm text-gray-500">{formatDate(request.created_at)}</span>
                            </div>
                          </div>
                          
                          {/* Status & Priority Badges */}
                          <div className="flex flex-col items-end gap-2 flex-shrink-0">
                            <span className={`px-3 py-1 rounded-full text-xs font-semibold ${statusInfo.bg} ${statusInfo.text}`}>
                              {statusInfo.label}
                            </span>
                            <span className={`px-3 py-1 rounded-lg text-xs font-semibold border ${priorityInfo.bg} ${priorityInfo.text} ${priorityInfo.border}`}>
                              {priorityInfo.label}
                            </span>
                          </div>
                        </div>

                        {/* Description */}
                        <p className="text-sm text-gray-500 line-clamp-2 mb-3">
                          {request.description || 'No description provided'}
                        </p>

                        {/* Meta Row */}
                        <div className="flex flex-wrap items-center gap-3">
                          {amount && (
                            <div className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-50 rounded-lg">
                              <svg className="w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                              </svg>
                              <span className="text-sm font-semibold text-gray-700">
                                {currency} {parseAmount(amount).toLocaleString()}
                              </span>
                            </div>
                          )}
                          
                          {activeTab === 'pending' && currentStep && (
                            <div className="flex items-center gap-1.5 px-3 py-1.5 bg-brand-50 rounded-lg">
                              <svg className="w-4 h-4 text-brand-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                              </svg>
                              <span className="text-sm font-medium text-brand-700">Step {currentStep.step_index + 1}</span>
                            </div>
                          )}

                          {activeTab === 'pending' && dueStatus && (
                            <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg ${dueStatus.className}`}>
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                              </svg>
                              <span className="text-sm font-medium">{dueStatus.label}</span>
                            </div>
                          )}

                          {/* Time on the current approver's desk (turns red past a day). */}
                          {activeTab === 'pending' && waitingMs != null && (
                            <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg ${waitingOverdue ? 'bg-red-50 text-red-700' : 'bg-gray-50 text-gray-600'}`}>
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                              </svg>
                              <span className="text-sm font-medium">
                                Waiting {formatDuration(waitingMs)}{waitingOverdue ? ' · overdue' : ''}
                              </span>
                            </div>
                          )}

                          {/* Supporting documents count. */}
                          {attachmentCount > 0 && (
                            <div className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-50 rounded-lg">
                              <svg className="w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                              </svg>
                              <span className="text-sm font-medium text-gray-700">{attachmentCount} file{attachmentCount === 1 ? '' : 's'}</span>
                            </div>
                          )}

                          {activeTab === 'history' && userAction && (
                            <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg ${
                              userAction === 'approved' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'
                            }`}>
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d={
                                  userAction === 'approved' ? 'M5 13l4 4L19 7' : 'M6 18L18 6M6 6l12 12'
                                } />
                              </svg>
                              <span className="text-sm font-medium">You {userAction}</span>
                            </div>
                          )}

                          {activeTab === 'watching' && (
                            <div className="flex items-center gap-1.5 px-3 py-1.5 bg-[#F3EADC] rounded-lg">
                              <svg className="w-4 h-4 text-[#9A7545]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                              </svg>
                              <span className="text-sm font-medium text-[#5E4426]">Watching</span>
                            </div>
                          )}
                        </div>

                        {/* Action Button */}
                        <div className="mt-4 flex items-center justify-between">
                          <span className="text-xs text-gray-400">
                            {request.metadata?.type?.toUpperCase() || 'REQUEST'}
                          </span>
                          <div className={`flex items-center gap-2 text-sm font-semibold ${
                            isCritical ? 'text-red-600' : isHighUrgent ? 'text-orange-600' : 'text-brand-600'
                          }`}>
                            {activeTab === 'pending' ? 'Review Now' : 'View Details'}
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 8l4 4m0 0l-4 4m4-4H3" />
                            </svg>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
      </div>
    </AppLayout>
  );
}
