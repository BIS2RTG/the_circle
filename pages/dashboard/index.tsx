import 'styled-jsx';
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/router';
import Head from 'next/head';
import Link from 'next/link';
import { GetServerSideProps } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '../api/auth/[...nextauth]';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { computeViewerStatus, type ViewerStatusBucket } from '@/lib/recentActivityStatus';
import { AppLayout } from '@/components/layout';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { useState, useEffect } from 'react';
import { Clock, CheckCircle2, XCircle, FileText, ArrowRight, TrendingUp, AlertTriangle, Fingerprint, ShieldCheck } from 'lucide-react';
import Lottie from 'lottie-react';
import BiometricSetupModal from '@/components/approvals/BiometricSetupModal';
import dashboardAnimation from '@/lotties/Dashboard.json';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

function getTimeAgo(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffInSeconds = Math.floor((now.getTime() - date.getTime()) / 1000);

  if (diffInSeconds < 60) return 'Just now';
  if (diffInSeconds < 3600) return `${Math.floor(diffInSeconds / 60)}m ago`;
  if (diffInSeconds < 86400) return `${Math.floor(diffInSeconds / 3600)}h ago`;
  if (diffInSeconds < 604800) return `${Math.floor(diffInSeconds / 86400)}d ago`;
  return date.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function TimeAgo({ dateString }: { dateString: string }) {
  const [timeAgo, setTimeAgo] = useState<string>('');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    setTimeAgo(getTimeAgo(dateString));
    
    const interval = setInterval(() => {
      setTimeAgo(getTimeAgo(dateString));
    }, 60000);
    
    return () => clearInterval(interval);
  }, [dateString]);

  if (!mounted) return null;
  
  return <>{timeAgo}</>;
}

interface DashboardStats {
  pending: number;
  approved: number;
  rejected: number;
  total: number;
  thisMonthRequests: number;
  completionRate: number;
}

interface RecentActivity {
  id: string;
  title: string;
  status: string;
  /** Status from the signed-in user's perspective (drives the badge). */
  viewerStatus: ViewerStatusBucket;
  /** Human label for the badge, e.g. "You approved" / "Awaiting you" / "Pending". */
  viewerStatusLabel: string;
  created_at: string;
  creator: {
    display_name: string | null;
    email: string;
  } | null;
  metadata: Record<string, any>;
}

interface DashboardProps {
  initialStats: DashboardStats;
  initialRecentActivity: RecentActivity[];
  initialPendingForUser: number;
  userName: string;
}

export const getServerSideProps: GetServerSideProps<DashboardProps> = async (context) => {
  const session = await getServerSession(context.req, context.res, authOptions);

  if (!session?.user) {
    return {
      redirect: {
        destination: '/',
        permanent: false,
      },
    };
  }

  const user = session.user as any;
  const organizationId = user.org_id;
  const userId = user.id;

  let stats: DashboardStats = {
    pending: 0,
    approved: 0,
    rejected: 0,
    total: 0,
    thisMonthRequests: 0,
    completionRate: 0,
  };
  let recentActivity: RecentActivity[] = [];
  let pendingForUser = 0;

  try {
    if (organizationId) {
      // Fetch all requests for the organization (excluding other users' drafts)
      const { data: requests } = await supabaseAdmin
        .from('requests')
        .select('id, status, created_at, creator_id')
        .eq('organization_id', organizationId);

      // Per-user dashboard: the stat cards reflect the signed-in user's OWN
      // requests (the ones they created), not organisation-wide totals — so
      // each user sees their own numbers.
      const allRequests = (requests || []).filter(r => r.creator_id === userId);

      // Calculate stats (drafts are NOT counted as pending - they are separate)
      stats.pending = allRequests.filter(r => r.status === 'pending').length;
      stats.approved = allRequests.filter(r => r.status === 'approved').length;
      stats.rejected = allRequests.filter(r => r.status === 'rejected').length;
      // Exclude drafts from total count for organization-wide stats
      stats.total = allRequests.filter(r => r.status !== 'draft').length;

      // This month's requests
      const startOfMonth = new Date();
      startOfMonth.setDate(1);
      startOfMonth.setHours(0, 0, 0, 0);
      stats.thisMonthRequests = allRequests.filter(
        r => new Date(r.created_at) >= startOfMonth
      ).length;

      // Completion rate
      const completed = stats.approved + stats.rejected;
      stats.completionRate = completed > 0 ? Math.round((stats.approved / completed) * 100) : 0;

      // Fetch pending approvals for the current user
      if (userId) {
        const { data: pendingSteps } = await supabaseAdmin
          .from('request_steps')
          .select('id')
          .eq('approver_user_id', userId)
          .eq('status', 'pending');
        
        pendingForUser = pendingSteps?.length || 0;
      }

      // Fetch recent activity with request_steps for visibility filtering
      const { data: recentRequests } = await supabaseAdmin
        .from('requests')
        .select(`
          id,
          title,
          status,
          created_at,
          metadata,
          creator_id,
          creator:app_users!requests_creator_id_fkey (
            display_name,
            email
          ),
          request_steps (
            approver_user_id,
            status
          )
        `)
        .eq('organization_id', organizationId)
        .neq('status', 'draft') // Exclude all drafts from recent activity
        .order('created_at', { ascending: false })
        .limit(50); // Fetch more to filter down

      // SEQUENTIAL APPROVAL VISIBILITY: Filter requests user can see
      // User can see if: creator, watcher, or approver with non-waiting step
      const filteredRequests = (recentRequests || []).filter((req: any) => {
        // Creator can always see
        if (req.creator_id === userId) return true;
        
        // Check if user is a watcher
        const watcherIds = req.metadata?.watchers || [];
        const isWatcher = Array.isArray(watcherIds) && watcherIds.some((w: any) => 
          typeof w === 'string' ? w === userId : w?.id === userId
        );
        if (isWatcher) return true;
        
        // Check if user is an approver with non-waiting step
        const userStep = req.request_steps?.find(
          (step: any) => step.approver_user_id === userId
        );
        if (userStep && userStep.status !== 'waiting') return true;
        
        return false;
      }).slice(0, 10); // Take only first 10 after filtering

      recentActivity = filteredRequests.map((req: any) => {
        const viewer = computeViewerStatus(req, userId);
        const { request_steps, ...rest } = req;
        return {
          ...rest,
          creator: Array.isArray(req.creator) ? req.creator[0] : req.creator,
          viewerStatus: viewer.status,
          viewerStatusLabel: viewer.label,
        };
      }) as RecentActivity[];
    }
  } catch (error) {
    console.error('Error fetching dashboard data:', error);
  }

  return {
    props: {
      initialStats: stats,
      initialRecentActivity: recentActivity,
      initialPendingForUser: pendingForUser,
      userName: user.name || 'User',
    },
  };
};

export default function Dashboard({ 
  initialStats, 
  initialRecentActivity, 
  initialPendingForUser,
  userName 
}: DashboardProps) {
  const { data: session } = useSession();
  const router = useRouter();

  // Device (passkey / biometric) registration status for the security card.
  const [deviceRegistered, setDeviceRegistered] = useState<boolean | null>(null);
  const [deviceCount, setDeviceCount] = useState(0);
  const [showBiometricSetup, setShowBiometricSetup] = useState(false);

  const loadDevices = async () => {
    try {
      const res = await fetch('/api/webauthn/credentials');
      // Leave state as "unknown" (null) on failure — reporting "no device
      // registered" off a transient error both misleads the user and would
      // fire the enrollment prompt at people who ARE registered.
      if (!res.ok) return;
      const data = await res.json();
      // Count only credentials usable on THIS domain (usable_here === false
      // means the passkey was registered for a different environment).
      const active = (data.credentials || []).filter(
        (c: any) => c.is_active && c.usable_here !== false
      );
      setDeviceCount(active.length);
      setDeviceRegistered(active.length > 0);
    } catch {
      /* network hiccup — keep the loading/unknown state */
    }
  };

  useEffect(() => {
    loadDevices();
  }, []);

  // Seed from SSR for an instant first paint, then keep the cards live by
  // refetching whenever the dashboard mounts or the tab regains focus — so the
  // counts reflect the latest approvals/submissions instead of a stale snapshot.
  const [stats, setStats] = useState<DashboardStats>(initialStats);
  const [pendingForUser, setPendingForUser] = useState<number>(initialPendingForUser);
  const recentActivity = initialRecentActivity;
  const statsLoading = false;

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const res = await fetch('/api/dashboard/stats');
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        if (data.stats) setStats(data.stats);
        if (typeof data.pendingForUser === 'number') setPendingForUser(data.pendingForUser);
      } catch {
        /* keep SSR values on failure */
      }
    };
    refresh();
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    return () => { cancelled = true; window.removeEventListener('focus', onFocus); };
  }, []);

  const firstName = userName?.split(' ')[0] || 'User';

  const getGreeting = () => {
    const hour = new Date().getHours();
    if (hour < 12) return 'Good morning';
    if (hour < 17) return 'Good afternoon';
    return 'Good evening';
  };

  const statsCards = [
    { label: 'Pending', value: stats.pending.toString(), Icon: Clock, trend: 'Awaiting action' },
    { label: 'Approved', value: stats.approved.toString(), Icon: CheckCircle2, trend: `${stats.completionRate}% approval rate` },
    { label: 'Rejected', value: stats.rejected.toString(), Icon: XCircle, trend: 'Declined requests' },
    { label: 'Total', value: stats.total.toString(), Icon: FileText, trend: 'All time' },
  ];

  return (
    <>
      <Head>
        <title>Dashboard - The Circle</title>
      </Head>

      <AppLayout title="Dashboard">
        <div className="w-full px-4 sm:px-6 lg:px-8 py-8 space-y-8">

          {/* Hero Banner — bright with polka dots */}
          <section className="relative overflow-hidden rounded-2xl border border-[#C9B896] shadow-sm bg-[#FBF6EF] p-8 sm:p-12">
            {/* Polka dot pattern */}
            <div
              aria-hidden
              className="absolute inset-0"
              style={{
                backgroundImage: 'radial-gradient(circle, #D4B483 1.2px, transparent 1.2px)',
                backgroundSize: '28px 28px',
                opacity: 0.35,
              }}
            />
            {/* Warm accent glow */}
            <div className="absolute -top-20 -right-20 w-72 h-72 rounded-full bg-gradient-to-br from-[#D4B483]/25 to-transparent blur-3xl" />

            <div className="relative z-10 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-6">
              <div className="space-y-3 flex-1">
                <p className="text-xs font-medium uppercase tracking-[0.14em] text-[#9A7545]">
                  {new Date().toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' })}
                </p>
                <h1 className="text-2xl sm:text-3xl lg:text-4xl font-semibold tracking-tight text-[#3F2D19]">
                  {getGreeting()},{' '}
                  <span className="animate-name-throb text-transparent bg-clip-text bg-gradient-to-r from-[#9A7545] to-[#C9A574] bg-[length:200%_200%]">
                    {firstName}.
                  </span>
                </h1>
                <p className="text-sm sm:text-base text-[#5E4426]/75 max-w-xl">
                  {pendingForUser > 0 ? (
                    <>You have <span className="font-semibold text-[#3F2D19]">{pendingForUser} pending item{pendingForUser !== 1 ? 's' : ''}</span> waiting for your review.</>
                  ) : (
                    <>You&apos;re all caught up — no items waiting for your review.</>
                  )}
                </p>
                {pendingForUser > 0 && (
                  <button
                    onClick={() => router.push('/approvals')}
                    className="group inline-flex items-center gap-2 mt-2 bg-[#3F2D19] text-white font-semibold py-3 px-6 rounded-lg shadow-md hover:bg-[#5E4426] transition-colors"
                  >
                    Review now
                    <ArrowRight className="w-4 h-4 group-hover:translate-x-0.5 transition-transform" />
                  </button>
                )}
              </div>

              <div className="hidden sm:block w-64 h-64 lg:w-80 lg:h-80 shrink-0 -mr-8 -mt-8 -mb-8">
                <Lottie
                  animationData={dashboardAnimation}
                  loop={true}
                  autoplay={true}
                  style={{ width: '100%', height: '100%' }}
                />
              </div>
            </div>

            {/* Throb animation style */}
            <style dangerouslySetInnerHTML={{ __html: `
              @keyframes name-throb {
                0%, 100% { background-position: 0% 50%; opacity: 1; }
                50% { background-position: 100% 50%; opacity: 0.85; }
              }
              .animate-name-throb {
                animation: name-throb 2.5s ease-in-out infinite;
              }
            ` }} />
          </section>

          {/* Stats Grid — minimal monochrome icons */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {statsCards.map(({ label, value, Icon, trend }) => (
              <div
                key={label}
                className="group relative bg-white rounded-xl p-5 border border-[#C9B896] hover:border-[#9A7545] hover:shadow-sm transition-all"
              >
                <div className="flex items-start justify-between mb-4">
                  <div className="text-neutral-700 flex items-center justify-center">
                    <Icon strokeWidth={1.5} size={20} />
                  </div>
                </div>
                <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">{label}</p>
                <h3 className="text-3xl font-semibold text-gray-900 mt-1 tabular-nums">{value}</h3>
                <p className="mt-3 text-xs text-gray-400">{trend}</p>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Recent Activity */}
            <section className="lg:col-span-2 bg-white rounded-xl border border-[#C9B896] p-6">
              <div className="flex items-center justify-between mb-5">
                <div>
                  <h3 className="text-base font-semibold text-gray-900">Recent Activity</h3>
                  <p className="text-xs text-gray-500 mt-0.5">Latest requests across your workspace</p>
                </div>
                <Link href="/requests/all" className="inline-flex items-center gap-1 text-sm text-gray-600 hover:text-gray-900 font-medium">
                  View all <ArrowRight className="w-3.5 h-3.5" />
                </Link>
              </div>

              <div className="divide-y divide-gray-100">
                {statsLoading ? (
                  <div className="flex items-center justify-center py-10">
                    <div className="w-6 h-6 border-2 border-gray-300 border-t-gray-700 rounded-full animate-spin" />
                  </div>
                ) : recentActivity.length === 0 ? (
                  <div className="text-center py-10 text-gray-500">
                    <p className="text-sm">No recent activity</p>
                    <p className="text-xs mt-1 text-gray-400">Create your first request to get started</p>
                  </div>
                ) : (
                  recentActivity.slice(0, 5).map((activity) => {
                    const creatorName = activity.creator?.display_name || activity.creator?.email?.split('@')[0] || 'Unknown';
                    const requestType = activity.metadata?.type || 'Request';
                    // Badge reflects the request from THIS user's perspective:
                    // an approver who has signed sees "You approved" rather than
                    // the request's still-in-progress "Pending".
                    const statusDisplay = activity.viewerStatusLabel;
                    const badgeStatus = activity.viewerStatus;

                    return (
                      <Link
                        key={activity.id}
                        href={`/requests/${activity.id}`}
                        className="group flex items-center gap-4 py-3.5 first:pt-0 last:pb-0 hover:bg-gray-50/60 -mx-2 px-2 rounded-lg transition-colors"
                      >
                        <div className="w-9 h-9 rounded-lg bg-gray-100 text-gray-600 flex items-center justify-center text-sm font-medium">
                          {creatorName.charAt(0).toUpperCase()}
                        </div>
                        <div className="flex-1 min-w-0">
                          <h4 className="font-medium text-sm text-gray-900 truncate group-hover:text-gray-700">{activity.title}</h4>
                          <div className="flex items-center gap-2 text-xs text-gray-500 mt-0.5">
                            <span>{creatorName}</span>
                            <span className="w-1 h-1 rounded-full bg-gray-300" />
                            <span>{requestType}</span>
                            <span className="w-1 h-1 rounded-full bg-gray-300" />
                            <span><TimeAgo dateString={activity.created_at} /></span>
                          </div>
                        </div>
                        <span className={cn(
                          "px-2 py-0.5 rounded-md text-[11px] font-medium border",
                          badgeStatus === 'approved' && "bg-emerald-50 text-emerald-700 border-emerald-100",
                          badgeStatus === 'pending' && "bg-amber-50 text-amber-700 border-amber-100",
                          badgeStatus === 'rejected' && "bg-rose-50 text-rose-700 border-rose-100",
                        )}>
                          {statusDisplay}
                        </span>
                      </Link>
                    );
                  })
                )}
              </div>
            </section>

            {/* Side Column */}
            <div className="space-y-6">
              {/* This Month */}
              <section className="bg-white rounded-xl border border-[#C9B896] p-6">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-2">
                    <TrendingUp className="w-4 h-4 text-neutral-700" strokeWidth={1.5} />
                    <h3 className="text-sm font-semibold text-gray-900">This Month</h3>
                  </div>
                  <span className="text-[11px] text-gray-400 uppercase tracking-wide">
                    {new Date().toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' })}
                  </span>
                </div>
                <div className="mb-5">
                  <h4 className="text-4xl font-semibold text-gray-900 tabular-nums">{stats.thisMonthRequests}</h4>
                  <p className="text-xs text-gray-500 mt-1">New requests created</p>
                </div>
                <div className="space-y-2">
                  <div className="flex justify-between text-xs">
                    <span className="text-gray-500">Approval rate</span>
                    <span className="font-medium text-gray-900 tabular-nums">{stats.completionRate}%</span>
                  </div>
                  <div className="h-1.5 bg-[#F3EADC] rounded-full overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-[#9A7545] to-[#C9A574] rounded-full transition-all duration-700"
                      style={{ width: `${stats.completionRate}%` }}
                    />
                  </div>
                </div>
              </section>

              {/* Device Registration (passkey / biometric) */}
              <section className="bg-white rounded-xl border border-[#C9B896] p-6">
                <div className="flex items-center gap-2 mb-4">
                  <Fingerprint className="w-4 h-4 text-neutral-700" strokeWidth={1.5} />
                  <h3 className="text-sm font-semibold text-gray-900">Device Registration</h3>
                </div>
                {deviceRegistered === null ? (
                  <div className="flex items-center justify-center py-4">
                    <div className="w-5 h-5 border-2 border-gray-300 border-t-gray-700 rounded-full animate-spin" />
                  </div>
                ) : deviceRegistered ? (
                  <div className="flex items-start gap-3">
                    <div className="p-1.5 bg-emerald-50 border border-emerald-200 rounded-md text-emerald-600">
                      <ShieldCheck className="w-4 h-4" strokeWidth={1.5} />
                    </div>
                    <div className="flex-1">
                      <p className="text-sm font-medium text-gray-900">Device registered</p>
                      <p className="text-xs text-gray-500 mt-0.5">
                        {deviceCount} {deviceCount === 1 ? 'device is' : 'devices are'} set up for biometric verification.
                      </p>
                      <button
                        onClick={() => setShowBiometricSetup(true)}
                        className="mt-2.5 inline-flex items-center gap-1 text-xs font-medium text-gray-900 hover:text-gray-700"
                      >
                        Register another <ArrowRight className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-start gap-3">
                    <div className="p-1.5 bg-neutral-100 border border-neutral-200 rounded-md text-neutral-700">
                      <AlertTriangle className="w-4 h-4" strokeWidth={1.5} />
                    </div>
                    <div className="flex-1">
                      <p className="text-sm font-medium text-gray-900">No device registered</p>
                      <p className="text-xs text-gray-500 mt-0.5 mb-2.5">Register this device to verify sensitive approvals with biometrics.</p>
                      <button
                        onClick={() => setShowBiometricSetup(true)}
                        className="inline-flex items-center gap-1 text-xs font-medium text-gray-900 hover:text-gray-700"
                      >
                        Register now <ArrowRight className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                )}
              </section>
            </div>
          </div>

        </div>

        <BiometricSetupModal
          isOpen={showBiometricSetup}
          onClose={() => setShowBiometricSetup(false)}
          onSuccess={() => { setShowBiometricSetup(false); loadDevices(); }}
        />
      </AppLayout>
    </>
  );
}
