import { useRouter } from 'next/router';
import { useEffect, useState, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Button } from '../ui';
import { parseAmount } from '../../lib/money';
import {
  Search,
  Plus,
  Clock,
  CheckCircle2,
  XCircle,
  Ban,
  FileText,
  Calendar,
  Paperclip,
  ChevronRight,
  ChevronLeft,
  type LucideIcon,
} from 'lucide-react';
import { formatDate } from '@/lib/formatDate';

export type RequestsMode = 'tracking' | 'drafts' | 'history';

interface Request {
  id: string;
  title: string;
  description: string;
  status: 'pending' | 'approved' | 'rejected' | 'in_review' | 'withdrawn' | 'draft' | 'cancelled';
  priority?: string;
  category?: string;
  created_at: string;
  updated_at: string;
  current_step?: number;
  total_steps?: number;
  completed_steps?: number;
  type?: string;
  metadata?: {
    priority?: string;
    requestType?: string;
    amount?: number;
    currency?: string;
    referenceCode?: string;
    [key: string]: any;
  };
  current_approver?: { id: string; name: string; email: string } | null;
  attachments_count?: number;
}

interface Stats {
  total: number;
  pending: number;
  approved: number;
  rejected: number;
  cancelled: number;
  withdrawn: number;
  draft: number;
}

function getRequestDetailPath(request: Request): string {
  const requestType = request.type || request.metadata?.type || request.metadata?.requestType;
  if (requestType === 'hotel_booking' || requestType === 'voucher_request') {
    return `/requests/comp/${request.id}`;
  }
  return `/requests/${request.id}`;
}

// Status pills keep a subtle, semantic tint — they are labels, not icons.
const statusConfig: Record<string, { label: string; bg: string; text: string; ring: string }> = {
  pending: { label: 'Pending', bg: 'bg-amber-50', text: 'text-amber-700', ring: 'ring-amber-100' },
  in_review: { label: 'In Review', bg: 'bg-amber-50', text: 'text-amber-700', ring: 'ring-amber-100' },
  approved: { label: 'Approved', bg: 'bg-emerald-50', text: 'text-emerald-700', ring: 'ring-emerald-100' },
  rejected: { label: 'Rejected', bg: 'bg-red-50', text: 'text-red-700', ring: 'ring-red-100' },
  withdrawn: { label: 'Withdrawn', bg: 'bg-neutral-100', text: 'text-neutral-600', ring: 'ring-neutral-200' },
  cancelled: { label: 'Cancelled', bg: 'bg-neutral-100', text: 'text-neutral-600', ring: 'ring-neutral-200' },
  draft: { label: 'Draft', bg: 'bg-neutral-100', text: 'text-neutral-600', ring: 'ring-neutral-200' },
};

const typeLabels: Record<string, string> = {
  approval: 'Approval',
  capex: 'CAPEX',
  leave: 'Leave',
  expense: 'Expense',
  procurement: 'Procurement',
  it_request: 'IT Request',
  hotel_booking: 'Hotel Booking',
  petty_cash: 'Petty Cash',
  voucher_request: 'Voucher',
  travel_authorization: 'Travel',
};

// `amount` may arrive as a display string ("10,931" / "$1,200.50") on some
// request types (e.g. CAPEX), so normalise via parseAmount first — passing a
// comma string straight to Intl.format() yields the dreaded "$NaN". Cents are
// preserved (shown only when present).
function formatCurrency(amount: unknown, currency: string = 'USD') {
  const n = parseAmount(amount);
  const cur = currency || 'USD';
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(n);
  } catch {
    return `${cur} ${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  }
}

const MODE_CONFIG: Record<RequestsMode, { title: string; subtitle: string; statuses?: string[] }> = {
  tracking: {
    title: 'My Requests',
    subtitle: 'Track, review and manage every request you have submitted — active and historical.',
  },
  drafts: {
    title: 'My Drafts',
    subtitle: 'Continue working on requests you have saved but not yet submitted.',
    statuses: ['draft'],
  },
  history: {
    title: 'Request History',
    subtitle: 'A record of your completed, withdrawn and cancelled requests.',
  },
};

// Unified status sections used by both the tracking ("My Requests") and history
// views, so a user always sees the same well-defined groups regardless of entry
// point. Drafts have their own dedicated page and are intentionally excluded.
type SectionTab = 'all' | 'pending' | 'approved' | 'rejected' | 'cancelled' | 'withdrawn';
const sectionTabs: { id: SectionTab; label: string; statuses: string[] }[] = [
  { id: 'all', label: 'All', statuses: ['pending', 'in_review', 'approved', 'rejected', 'cancelled', 'withdrawn'] },
  { id: 'pending', label: 'Pending', statuses: ['pending', 'in_review'] },
  { id: 'approved', label: 'Approved', statuses: ['approved'] },
  { id: 'rejected', label: 'Rejected', statuses: ['rejected'] },
  { id: 'cancelled', label: 'Cancelled', statuses: ['cancelled'] },
  { id: 'withdrawn', label: 'Withdrawn', statuses: ['withdrawn'] },
];

const PAGE_SIZE = 8;

const EMPTY_STATS: Stats = { total: 0, pending: 0, approved: 0, rejected: 0, cancelled: 0, withdrawn: 0, draft: 0 };

export default function RequestsView({ mode }: { mode: RequestsMode }) {
  const router = useRouter();
  const [requests, setRequests] = useState<Request[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState<SectionTab>('all');
  const [page, setPage] = useState(1);
  const [stats, setStats] = useState<Stats>(EMPTY_STATS);

  const cfg = MODE_CONFIG[mode];
  // Tracking + history share the unified, sectioned, paginated experience.
  const usesSections = mode === 'tracking' || mode === 'history';

  useEffect(() => {
    let active = true;
    async function fetchMyRequests() {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch('/api/requests/my-requests?limit=500');
        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.error || 'Failed to fetch requests');
        }
        const data = await response.json();
        if (!active) return;
        setRequests(data.requests || []);
        setStats({ ...EMPTY_STATS, ...(data.stats || {}) });
      } catch (err: any) {
        if (active) setError(err.message || 'Failed to load requests');
      } finally {
        if (active) setLoading(false);
      }
    }
    fetchMyRequests();
    return () => { active = false; };
  }, []);

  // Reset to the first page whenever the section or the search term changes, so
  // the user never lands on an out-of-range page.
  useEffect(() => {
    setPage(1);
  }, [activeTab, searchQuery]);

  const statsCards: { label: string; value: number; Icon: LucideIcon; tab: SectionTab }[] = [
    { label: 'Total', value: stats.total, Icon: FileText, tab: 'all' },
    { label: 'Pending', value: stats.pending, Icon: Clock, tab: 'pending' },
    { label: 'Approved', value: stats.approved, Icon: CheckCircle2, tab: 'approved' },
    { label: 'Rejected', value: stats.rejected, Icon: XCircle, tab: 'rejected' },
    { label: 'Cancelled', value: stats.cancelled, Icon: Ban, tab: 'cancelled' },
  ];

  const filteredRequests = useMemo(() => {
    const allowedStatuses = usesSections
      ? sectionTabs.find(t => t.id === activeTab)!.statuses
      : cfg.statuses!;

    return requests.filter((req) => {
      if (!allowedStatuses.includes(req.status)) return false;
      const q = searchQuery.toLowerCase();
      if (!q) return true;
      const refCode = (req.metadata?.referenceCode || '') as string;
      return (
        req.title.toLowerCase().includes(q) ||
        (req.description || '').toLowerCase().includes(q) ||
        (req.category || '').toLowerCase().includes(q) ||
        refCode.toLowerCase().includes(q)
      );
    });
  }, [requests, usesSections, activeTab, searchQuery, cfg.statuses]);

  // Client-side pagination over the filtered set.
  const totalPages = Math.max(1, Math.ceil(filteredRequests.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pagedRequests = filteredRequests.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
  const rangeStart = filteredRequests.length === 0 ? 0 : (safePage - 1) * PAGE_SIZE + 1;
  const rangeEnd = Math.min(safePage * PAGE_SIZE, filteredRequests.length);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-500" />
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-text-primary tracking-tight">{cfg.title}</h1>
          <p className="text-text-secondary mt-1.5 text-sm sm:text-base">{cfg.subtitle}</p>
        </div>
        <Button variant="primary" onClick={() => router.push('/requests/new')} className="flex items-center gap-2 shrink-0">
          <Plus className="w-4 h-4" strokeWidth={1.5} />
          New Request
        </Button>
      </div>

      {error && (
        <div className="bg-danger-50 border border-danger-100 text-danger-600 text-sm rounded-xl px-4 py-3">{error}</div>
      )}

      {/* Stats */}
      {usesSections && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 sm:gap-4">
          {statsCards.map(({ label, value, Icon, tab }) => (
            <button
              key={label}
              onClick={() => setActiveTab(tab)}
              className={`text-left bg-white rounded-2xl p-4 border transition-all hover:shadow-card-hover ${activeTab === tab ? 'border-primary-300 ring-1 ring-primary-100' : 'border-border'}`}
            >
              <span className="text-neutral-700 flex items-center justify-center w-9 h-9">
                <Icon className="w-[20px] h-[20px]" strokeWidth={1.5} />
              </span>
              <p className="text-2xl font-bold text-text-primary mt-2 tabular-nums">{value}</p>
              <p className="text-xs text-text-secondary">{label}</p>
            </button>
          ))}
        </div>
      )}

      {/* Section tabs + Search */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        {usesSections ? (
          <div className="flex p-1 bg-neutral-100 rounded-full w-full sm:w-auto overflow-x-auto">
            {sectionTabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`px-4 py-1.5 rounded-full text-sm font-medium transition-all whitespace-nowrap ${activeTab === tab.id ? 'bg-white text-text-primary shadow-soft' : 'text-text-secondary hover:text-text-primary'}`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        ) : (
          <span className="text-sm text-text-secondary font-medium">
            {filteredRequests.length} {filteredRequests.length === 1 ? 'request' : 'requests'}
          </span>
        )}

        <div className="relative w-full sm:w-72">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" strokeWidth={1.5} />
          <input
            type="text"
            placeholder="Search by title, reference or category"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-4 h-10 bg-neutral-100 border border-transparent rounded-full text-sm text-text-primary placeholder:text-text-muted focus:bg-white focus:border-primary-300 focus:ring-2 focus:ring-primary-100 outline-none transition-all"
          />
        </div>
      </div>

      {/* List */}
      <div className="min-h-[300px]">
        {filteredRequests.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 bg-white rounded-2xl border border-dashed border-border">
            <div className="w-14 h-14 bg-neutral-100 rounded-full flex items-center justify-center mb-4 text-text-muted">
              <FileText className="w-6 h-6" strokeWidth={1.5} />
            </div>
            <h3 className="text-base font-semibold text-text-primary mb-1">No requests found</h3>
            <p className="text-sm text-text-secondary mb-5">
              {searchQuery
                ? `No requests matching "${searchQuery}"`
                : usesSections && activeTab !== 'all'
                  ? `You have no ${sectionTabs.find(t => t.id === activeTab)!.label.toLowerCase()} requests.`
                  : `You have no ${cfg.title.toLowerCase()} yet.`}
            </p>
            {mode !== 'drafts' && !searchQuery && (
              <Button variant="secondary" onClick={() => router.push('/requests/new')}>Start a New Request</Button>
            )}
          </div>
        ) : (
          <div className="grid gap-3">
            <AnimatePresence mode="wait">
              {pagedRequests.map((request, index) => {
                const statusInfo = statusConfig[request.status] || statusConfig['pending'];
                const requestType = request.type || request.metadata?.requestType || 'approval';
                const typeLabel = typeLabels[requestType] || 'Request';
                const amount = request.metadata?.amount;
                const currency = request.metadata?.currency;

                return (
                  <motion.div
                    key={request.id}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.2, delay: Math.min(index * 0.03, 0.25) }}
                    onClick={() => router.push(getRequestDetailPath(request))}
                    className="group cursor-pointer bg-white rounded-2xl border border-border hover:border-neutral-300 hover:shadow-card-hover transition-all p-4 sm:p-5"
                  >
                    <div className="flex items-center gap-4">
                      {/* Type icon — plain monochrome glyph */}
                      <span className="shrink-0 w-9 flex items-center justify-center text-neutral-700">
                        <FileText className="w-5 h-5" strokeWidth={1.5} />
                      </span>

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                          <span className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">{typeLabel}</span>
                          {request.metadata?.referenceCode && (
                            <span className="text-[10px] font-mono font-semibold text-text-secondary bg-neutral-100 px-2 py-0.5 rounded border border-border tracking-wider">
                              {request.metadata.referenceCode}
                            </span>
                          )}
                        </div>
                        <h3 className="font-semibold text-text-primary truncate group-hover:text-primary-700 transition-colors">
                          {request.title}
                        </h3>
                        <div className="flex items-center gap-x-3 gap-y-1 mt-1 text-xs text-text-muted flex-wrap">
                          <span className="inline-flex items-center gap-1">
                            <Calendar className="w-3.5 h-3.5" strokeWidth={1.5} />
                            {formatDate(request.created_at)}
                          </span>
                          {request.attachments_count ? (
                            <span className="inline-flex items-center gap-1">
                              <Paperclip className="w-3.5 h-3.5" strokeWidth={1.5} />
                              {request.attachments_count}
                            </span>
                          ) : null}
                          {(request.current_step && request.total_steps) ? (
                            <span>Step {request.current_step} of {request.total_steps}</span>
                          ) : null}
                        </div>
                      </div>

                      <div className="flex flex-col items-end gap-1.5 shrink-0">
                        <span className={`px-2.5 py-1 rounded-full text-xs font-semibold ring-1 ring-inset ${statusInfo.bg} ${statusInfo.text} ${statusInfo.ring}`}>
                          {statusInfo.label}
                        </span>
                        {amount ? <span className="text-sm font-semibold text-text-primary">{formatCurrency(amount, currency)}</span> : null}
                      </div>

                      <ChevronRight className="hidden sm:block w-5 h-5 text-neutral-300 group-hover:text-neutral-500 group-hover:translate-x-0.5 transition-all shrink-0" strokeWidth={1.5} />
                    </div>

                    {/* Progress (pending/in_review) */}
                    {['pending', 'in_review'].includes(request.status) && request.total_steps && request.total_steps > 0 && (
                      <div className="mt-4 pt-3 border-t border-border">
                        <div className="flex items-center gap-3">
                          <div className="flex items-center gap-1.5 flex-1">
                            {Array.from({ length: request.total_steps }).map((_, idx) => {
                              const isCompleted = idx < (request.completed_steps || 0);
                              const isCurrent = idx === (request.completed_steps || 0);
                              return (
                                <div
                                  key={idx}
                                  className={`h-1.5 flex-1 rounded-full transition-colors ${isCompleted ? 'bg-primary-500' : isCurrent ? 'bg-primary-300' : 'bg-neutral-200'}`}
                                />
                              );
                            })}
                          </div>
                          <span className="text-xs font-medium text-text-secondary whitespace-nowrap">
                            {request.completed_steps || 0} of {request.total_steps} approved
                          </span>
                        </div>
                        {request.current_approver && (
                          <p className="mt-2 text-xs text-text-secondary">
                            Awaiting approval from <span className="font-medium text-text-primary">{request.current_approver.name}</span>
                          </p>
                        )}
                      </div>
                    )}
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </div>
        )}
      </div>

      {/* Pagination */}
      {filteredRequests.length > PAGE_SIZE && (
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-1">
          <span className="text-xs text-text-secondary">
            Showing <span className="font-medium text-text-primary">{rangeStart}–{rangeEnd}</span> of{' '}
            <span className="font-medium text-text-primary">{filteredRequests.length}</span>
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={safePage <= 1}
              className="inline-flex items-center gap-1 px-3 h-9 rounded-lg border border-border bg-white text-sm font-medium text-text-secondary hover:text-text-primary hover:border-neutral-300 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <ChevronLeft className="w-4 h-4" strokeWidth={1.5} />
              Prev
            </button>
            {Array.from({ length: totalPages }).map((_, idx) => {
              const pageNum = idx + 1;
              // Compact window: first, last, and neighbours of the current page.
              const isEdge = pageNum === 1 || pageNum === totalPages;
              const isNear = Math.abs(pageNum - safePage) <= 1;
              if (!isEdge && !isNear) {
                // Render a single ellipsis at the gap boundaries.
                if (pageNum === 2 || pageNum === totalPages - 1) {
                  return <span key={pageNum} className="px-1.5 text-text-muted">…</span>;
                }
                return null;
              }
              return (
                <button
                  key={pageNum}
                  onClick={() => setPage(pageNum)}
                  className={`min-w-9 h-9 px-2 rounded-lg text-sm font-medium transition-colors ${
                    pageNum === safePage
                      ? 'bg-primary-600 text-white'
                      : 'bg-white border border-border text-text-secondary hover:text-text-primary hover:border-neutral-300'
                  }`}
                >
                  {pageNum}
                </button>
              );
            })}
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={safePage >= totalPages}
              className="inline-flex items-center gap-1 px-3 h-9 rounded-lg border border-border bg-white text-sm font-medium text-text-secondary hover:text-text-primary hover:border-neutral-300 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Next
              <ChevronRight className="w-4 h-4" strokeWidth={1.5} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
