import { GetServerSideProps } from 'next';
import { useMemo, useState } from 'react';
import { useRouter } from 'next/router';
import { getServerSession } from 'next-auth';
import { authOptions } from '../api/auth/[...nextauth]';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getUserRBACProfile, hasPermission, PERMISSIONS } from '@/lib/rbac';
import { AppLayout } from '../../components/layout';
import { Button } from '../../components/ui';
import { parseAmount } from '@/lib/money';

/**
 * Super-admin "all requests" console.
 *
 * A read-only, org-wide list of every request (not just the ones the viewer is
 * involved in) with a per-request approval-workflow summary. Gated to super
 * admins and holders of requests.view_all (auditors). Opening a request links
 * to the normal detail page, which already grants elevated viewers access.
 */

interface StepSummary {
  step_index: number;
  status: string;
  approver_name: string;
  activated_at: string | null;
  decided_at: string | null;
  decision: string | null;
}

interface RequestRow {
  id: string;
  title: string;
  status: string;
  created_at: string;
  creator_name: string;
  type: string | null;
  reference: string | null;
  amount: string | null;
  currency: string | null;
  steps: StepSummary[];
  current_step: number | null;
  current_approver: string | null;
}

interface Props {
  requests: RequestRow[];
}

const STATUS_STYLE: Record<string, string> = {
  approved: 'bg-green-100 text-green-700',
  completed: 'bg-green-100 text-green-700',
  rejected: 'bg-red-100 text-red-700',
  withdrawn: 'bg-gray-100 text-gray-600',
  cancelled: 'bg-gray-100 text-gray-600',
  pending: 'bg-yellow-100 text-yellow-700',
  draft: 'bg-gray-100 text-gray-500',
};

const STEP_STYLE: Record<string, { dot: string; label: string }> = {
  approved: { dot: 'bg-green-500', label: 'Approved' },
  rejected: { dot: 'bg-red-500', label: 'Rejected' },
  pending: { dot: 'bg-yellow-500', label: 'On desk' },
  waiting: { dot: 'bg-gray-300', label: 'Waiting' },
};

function fmtDate(d: string | null): string {
  if (!d) return '—';
  return new Date(d).toLocaleString('en-GB', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export default function AdminRequestsPage({ requests }: Props) {
  const router = useRouter();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return requests.filter((r) => {
      const matchesSearch =
        !q ||
        r.title.toLowerCase().includes(q) ||
        (r.reference || '').toLowerCase().includes(q) ||
        r.creator_name.toLowerCase().includes(q);
      const matchesStatus = statusFilter === 'all' || r.status === statusFilter;
      return matchesSearch && matchesStatus;
    });
  }, [requests, search, statusFilter]);

  const selected = useMemo(
    () => requests.find((r) => r.id === selectedId) || null,
    [requests, selectedId]
  );

  const detailPath = (r: RequestRow) =>
    r.type === 'hotel_booking' || r.type === 'voucher_request'
      ? `/requests/comp/${r.id}`
      : `/requests/${r.id}`;

  return (
    <AppLayout title="All Requests">
      <div className="flex flex-col h-[calc(100vh-64px)] overflow-hidden">
        {/* Header */}
        <div className="flex-shrink-0 p-6 border-b border-gray-200 bg-white">
          <h1 className="text-2xl font-bold text-gray-900 font-heading">All Requests</h1>
          <p className="text-gray-500 mt-1 text-sm">
            Org-wide view of every request and its approval workflow. Read-only oversight for administrators.
          </p>
          <div className="flex flex-wrap gap-3 mt-4">
            <input
              type="text"
              placeholder="Search by title, reference, or requester…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="flex-1 min-w-[220px] px-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="px-3 py-2 rounded-lg border border-gray-300 bg-white text-sm"
            >
              <option value="all">All statuses</option>
              <option value="pending">Pending</option>
              <option value="approved">Approved</option>
              <option value="rejected">Rejected</option>
              <option value="withdrawn">Withdrawn</option>
            </select>
            <span className="px-3 py-2 text-sm text-gray-400">{filtered.length} of {requests.length}</span>
          </div>
        </div>

        {/* Split view */}
        <div className="flex-1 flex overflow-hidden bg-gray-50/50">
          {/* List */}
          <div className={`flex flex-col border-r border-gray-200 bg-white w-full lg:w-[440px] ${selected ? 'hidden lg:flex' : 'flex'}`}>
            <div className="flex-1 overflow-y-auto divide-y divide-gray-50">
              {filtered.length === 0 ? (
                <div className="p-10 text-center text-gray-400 text-sm">No requests match.</div>
              ) : (
                filtered.map((r) => (
                  <button
                    key={r.id}
                    onClick={() => setSelectedId(r.id)}
                    className={`w-full text-left px-4 py-3 hover:bg-gray-50 border-l-4 ${
                      selectedId === r.id ? 'bg-[#F3EADC]/50 border-brand-500' : 'border-transparent'
                    }`}
                  >
                    <div className="flex justify-between items-start gap-2">
                      <span className="text-sm font-semibold text-gray-900 truncate">{r.title}</span>
                      <span className={`text-[10px] uppercase font-bold px-1.5 py-0.5 rounded ${STATUS_STYLE[r.status] || 'bg-gray-100 text-gray-600'}`}>
                        {r.status}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-gray-500 mt-1">
                      {r.reference && <span className="font-mono">{r.reference}</span>}
                      <span>·</span>
                      <span>{r.creator_name}</span>
                    </div>
                    <div className="text-xs text-gray-400 mt-0.5">
                      {r.current_approver ? `On ${r.current_approver}'s desk` : `${r.steps.filter((s) => s.status === 'approved').length}/${r.steps.length} approved`}
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>

          {/* Detail: workflow summary */}
          {selected ? (
            <div className="flex-1 overflow-y-auto p-4 md:p-8">
              <div className="max-w-3xl mx-auto space-y-6">
                <button onClick={() => setSelectedId(null)} className="lg:hidden text-sm text-gray-500">← Back</button>

                <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6">
                  <div className="flex flex-col md:flex-row justify-between gap-4">
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        {selected.reference && (
                          <span className="px-2 py-0.5 rounded bg-gray-100 text-gray-600 font-mono text-xs">{selected.reference}</span>
                        )}
                        <span className={`text-[10px] uppercase font-bold px-1.5 py-0.5 rounded ${STATUS_STYLE[selected.status] || 'bg-gray-100 text-gray-600'}`}>
                          {selected.status}
                        </span>
                      </div>
                      <h2 className="text-xl font-bold text-gray-900">{selected.title}</h2>
                      <p className="text-sm text-gray-500 mt-1">
                        {selected.creator_name}
                        {selected.amount ? ` · ${selected.currency || '$'} ${parseAmount(selected.amount).toLocaleString()}` : ''}
                        {' · '}{fmtDate(selected.created_at)}
                      </p>
                    </div>
                    <div>
                      <Button size="sm" variant="secondary" onClick={() => router.push(detailPath(selected))}>
                        Open request
                      </Button>
                    </div>
                  </div>
                </div>

                {/* Approval workflow summary */}
                <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
                  <div className="px-5 py-4 border-b border-gray-100">
                    <h3 className="font-bold text-gray-900 text-sm">Approval Workflow</h3>
                    <p className="text-xs text-gray-400 mt-0.5">
                      {selected.steps.filter((s) => s.status === 'approved').length} of {selected.steps.length} steps approved
                      {selected.current_approver ? ` · currently with ${selected.current_approver}` : ''}
                    </p>
                  </div>
                  <ol className="divide-y divide-gray-50">
                    {selected.steps.map((s) => {
                      const style = STEP_STYLE[s.status] || { dot: 'bg-gray-300', label: s.status };
                      return (
                        <li key={s.step_index} className="px-5 py-3 flex items-center gap-3">
                          <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${style.dot}`} />
                          <span className="text-xs font-mono text-gray-400 w-6">#{s.step_index}</span>
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-medium text-gray-900 truncate">{s.approver_name}</div>
                            <div className="text-xs text-gray-400">
                              {s.decided_at ? `${style.label} · ${fmtDate(s.decided_at)}` :
                                s.activated_at ? `${style.label} since ${fmtDate(s.activated_at)}` : style.label}
                            </div>
                          </div>
                          <span className="text-[10px] font-bold uppercase text-gray-500">{style.label}</span>
                        </li>
                      );
                    })}
                  </ol>
                </div>
              </div>
            </div>
          ) : (
            <div className="hidden lg:flex flex-1 items-center justify-center text-gray-400 text-sm">
              Select a request to view its approval workflow.
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}

export const getServerSideProps: GetServerSideProps<Props> = async (context) => {
  const session = await getServerSession(context.req, context.res, authOptions);
  const userId = (session?.user as any)?.id;
  const organizationId = (session?.user as any)?.org_id;

  if (!userId) {
    return { redirect: { destination: '/', permanent: false } };
  }

  // Gate: super admins and holders of requests.view_all only.
  const profile = await getUserRBACProfile(userId);
  const allowed = profile.is_super_admin || hasPermission(profile, PERMISSIONS.REQUESTS_VIEW_ALL);
  if (!allowed) {
    return { redirect: { destination: '/dashboard', permanent: false } };
  }

  const { data, error } = await supabaseAdmin
    .from('requests')
    .select(`
      id, title, status, metadata, created_at, organization_id,
      creator:app_users!requests_creator_id_fkey ( display_name, email ),
      request_steps (
        step_index, status, approver_user_id, activated_at,
        approver:app_users!request_steps_approver_user_id_fkey ( display_name, email ),
        approvals ( decision, signed_at )
      )
    `)
    .eq('organization_id', organizationId)
    .not('status', 'eq', 'draft')
    .order('created_at', { ascending: false })
    .limit(1000);

  if (error) {
    console.error('admin/requests fetch failed:', error);
    return { props: { requests: [] } };
  }

  const requests: RequestRow[] = (data || []).map((r: any) => {
    const creator = Array.isArray(r.creator) ? r.creator[0] : r.creator;
    const steps: StepSummary[] = (r.request_steps || [])
      .slice()
      .sort((a: any, b: any) => a.step_index - b.step_index)
      .map((s: any) => {
        const approver = Array.isArray(s.approver) ? s.approver[0] : s.approver;
        const approval = Array.isArray(s.approvals) ? s.approvals[0] : s.approvals;
        return {
          step_index: s.step_index,
          status: s.status,
          approver_name: approver?.display_name || approver?.email || 'Unassigned',
          activated_at: s.activated_at || null,
          decided_at: approval?.signed_at || null,
          decision: approval?.decision || null,
        };
      });
    const current = steps.find((s) => s.status === 'pending') || null;
    return {
      id: r.id,
      title: r.title,
      status: r.status,
      created_at: r.created_at,
      creator_name: creator?.display_name || creator?.email || 'Unknown',
      type: r.metadata?.type || r.metadata?.requestType || null,
      reference: r.metadata?.referenceCode || r.metadata?.reference_number || null,
      amount: r.metadata?.amount || r.metadata?.total_amount || null,
      currency: r.metadata?.currency || null,
      steps,
      current_step: current?.step_index ?? null,
      current_approver: current?.approver_name ?? null,
    };
  });

  return { props: { requests } };
};
