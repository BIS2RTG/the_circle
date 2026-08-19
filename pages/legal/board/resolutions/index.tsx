import { useEffect, useMemo, useState, useCallback } from 'react';
import Link from 'next/link';
import { GetServerSideProps } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '../../../api/auth/[...nextauth]';
import { AppLayout } from '../../../../components/layout';
import { Card, Button } from '../../../../components/ui';
import Loader from '@/components/Loader';
import ResolutionFormModal from '../../../../components/legal/bgm/ResolutionFormModal';
import TaskUpdateModal from '../../../../components/legal/bgm/TaskUpdateModal';
import { useRBAC, useRequirePermission } from '../../../../contexts/RBACContext';
import {
  effectiveStatus, summariseResolution, daysUntilDue,
  EFFECTIVE_STATUSES, TASK_STATUS_LABELS, TASK_STATUS_STYLES, EffectiveStatus,
} from '@/lib/bgmResolutions';
import {
  Gavel, Plus, Search, ChevronRight, User, CalendarClock, ClipboardList,
  LayoutGrid, CircleSlash,
} from 'lucide-react';

type View = 'resolutions' | 'board';

function fmtDate(iso: string | null) {
  if (!iso) return null;
  try { return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' }).format(new Date(iso)); } catch { return null; }
}

export default function ResolutionsPage() {
  const { hasPermission } = useRBAC();
  useRequirePermission(['bgm.resolutions.view', 'legal.access']);
  const canManage = hasPermission('bgm.resolutions.manage');
  const canUpdate = hasPermission('bgm.resolutions.update') || canManage;

  const [view, setView] = useState<View>('resolutions');
  const [loading, setLoading] = useState(true);
  const [resolutions, setResolutions] = useState<any[]>([]);
  const [meetings, setMeetings] = useState<any[]>([]);
  const [committees, setCommittees] = useState<any[]>([]);
  const [formOpen, setFormOpen] = useState(false);
  const [updateTask, setUpdateTask] = useState<any>(null);

  const [searchQ, setSearchQ] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | EffectiveStatus>('all');

  const load = useCallback(async () => {
    setLoading(true);
    const [rr, cr, mr] = await Promise.all([
      fetch('/api/legal/bgm/resolutions'),
      fetch('/api/legal/bgm/committees'),
      fetch(`/api/legal/bgm/meetings?year=${new Date().getFullYear()}`),
    ]);
    if (rr.ok) setResolutions((await rr.json()).resolutions || []);
    if (cr.ok) setCommittees((await cr.json()).committees || []);
    if (mr.ok) setMeetings((await mr.json()).meetings || []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  // Flat task list with derived status + parent resolution reference.
  const allTasks = useMemo(() => {
    const out: any[] = [];
    for (const r of resolutions) {
      for (const t of r.tasks || []) {
        out.push({ ...t, eff: effectiveStatus(t), resolution: { id: r.id, title: r.title } });
      }
    }
    return out;
  }, [resolutions]);

  const counts = useMemo(() => {
    const c: Record<EffectiveStatus, number> = { pending: 0, in_progress: 0, overdue: 0, resolved: 0 };
    for (const t of allTasks) c[t.eff as EffectiveStatus] += 1;
    return c;
  }, [allTasks]);

  const q = searchQ.trim().toLowerCase();

  const filteredResolutions = useMemo(() => {
    return resolutions.filter((r) => {
      if (q) {
        const hay = `${r.title} ${r.reference || ''} ${r.category || ''} ${(r.tasks || []).map((t: any) => `${t.title} ${t.owner?.display_name || t.owner_name || ''}`).join(' ')}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (statusFilter !== 'all') {
        const has = (r.tasks || []).some((t: any) => effectiveStatus(t) === statusFilter);
        if (!has) return false;
      }
      return true;
    });
  }, [resolutions, q, statusFilter]);

  const filteredTasks = useMemo(() => {
    return allTasks.filter((t) => {
      if (q && !(`${t.title} ${t.owner?.display_name || t.owner_name || ''} ${t.resolution.title}`.toLowerCase().includes(q))) return false;
      return true;
    });
  }, [allTasks, q]);

  return (
    <AppLayout title="Resolution Tracker">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
        {/* Header */}
        <div className="flex flex-wrap items-start justify-between gap-3 mb-5">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-primary-500">
              <Link href="/legal" className="hover:underline">Legal</Link> ·{' '}
              <Link href="/legal/board" className="hover:underline">Board Governance</Link> · Resolutions
            </p>
            <h1 className="mt-1 text-2xl sm:text-3xl font-bold tracking-tight text-text-primary">Resolution &amp; Action Tracker</h1>
            <p className="mt-1 text-sm text-text-secondary max-w-2xl">
              Board resolutions mapped to responsible owners, with deadlines, live status and automated progress reminders.
            </p>
          </div>
          {canManage && (
            <Button variant="primary" onClick={() => setFormOpen(true)}>
              <Plus className="w-4 h-4 mr-1.5" /> Record resolution
            </Button>
          )}
        </div>

        {/* Status summary — click to filter */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
          {EFFECTIVE_STATUSES.map((s) => {
            const st = TASK_STATUS_STYLES[s];
            const active = statusFilter === s;
            return (
              <button key={s} onClick={() => setStatusFilter(active ? 'all' : s)}
                className={`text-left rounded-xl border p-3.5 transition-all ${active ? `${st.bg} border-transparent ring-2 ${st.ring}` : 'bg-white border-border hover:border-neutral-300'}`}>
                <div className="flex items-center gap-1.5">
                  <span className={`w-2 h-2 rounded-full ${st.dot}`} />
                  <span className="text-[11px] uppercase tracking-wider font-semibold text-neutral-500">{TASK_STATUS_LABELS[s]}</span>
                </div>
                <p className={`mt-1 text-2xl font-bold ${s === 'overdue' && counts[s] > 0 ? 'text-rose-600' : 'text-text-primary'}`}>{counts[s]}</p>
              </button>
            );
          })}
        </div>

        {/* View toggle + search */}
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <div className="inline-flex rounded-lg border border-gray-200 overflow-hidden">
            {([['resolutions', 'By resolution', <ClipboardList key="a" className="w-4 h-4" />], ['board', 'Action board', <LayoutGrid key="b" className="w-4 h-4" />]] as [View, string, React.ReactNode][]).map(([k, label, icon]) => (
              <button key={k} onClick={() => setView(k)}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium transition-colors ${view === k ? 'bg-primary-600 text-white' : 'bg-white text-neutral-600 hover:bg-neutral-50'}`}>
                {icon}{label}
              </button>
            ))}
          </div>
          <div className="relative flex-1 min-w-[180px]">
            <Search className="w-4 h-4 text-neutral-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input value={searchQ} onChange={(e) => setSearchQ(e.target.value)} placeholder="Search resolutions, actions or owners…"
              className="w-full pl-9 pr-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
          </div>
          {statusFilter !== 'all' && (
            <button onClick={() => setStatusFilter('all')} className="text-sm text-neutral-500 hover:text-neutral-800 inline-flex items-center gap-1">
              <CircleSlash className="w-4 h-4" /> Clear filter
            </button>
          )}
        </div>

        {loading ? (
          <div className="py-20 flex justify-center"><Loader /></div>
        ) : resolutions.length === 0 ? (
          <Card variant="default" padding="lg" className="text-center">
            <Gavel className="w-10 h-10 text-neutral-300 mx-auto mb-2" />
            <p className="text-sm text-neutral-500">No resolutions recorded yet.</p>
            {canManage && <Button variant="outline" className="mt-3" onClick={() => setFormOpen(true)}><Plus className="w-4 h-4 mr-1.5" /> Record the first resolution</Button>}
          </Card>
        ) : view === 'resolutions' ? (
          <div className="space-y-4">
            {filteredResolutions.length === 0 && <Card variant="default" padding="lg" className="text-center text-sm text-neutral-500">No resolutions match.</Card>}
            {filteredResolutions.map((r) => (
              <ResolutionCard key={r.id} r={r} canUpdate={canUpdate} onUpdateTask={setUpdateTask} />
            ))}
          </div>
        ) : (
          <ActionBoard tasks={filteredTasks} canUpdate={canUpdate} onUpdateTask={setUpdateTask} />
        )}
      </div>

      <ResolutionFormModal
        isOpen={formOpen}
        onClose={() => setFormOpen(false)}
        meetings={meetings}
        committees={committees}
        onCreated={() => load()}
      />
      <TaskUpdateModal
        isOpen={!!updateTask}
        onClose={() => setUpdateTask(null)}
        task={updateTask}
        onUpdated={load}
      />
    </AppLayout>
  );
}

function StatusChip({ status }: { status: EffectiveStatus }) {
  const st = TASK_STATUS_STYLES[status];
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium ${st.bg} ${st.text}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${st.dot}`} />{TASK_STATUS_LABELS[status]}
    </span>
  );
}

function OwnerLabel({ task }: { task: any }) {
  const name = task.owner?.display_name || task.owner_name;
  if (!name) return <span className="text-neutral-400 italic">Unassigned</span>;
  return <span className="inline-flex items-center gap-1"><User className="w-3.5 h-3.5 text-neutral-400" />{name}</span>;
}

function DueLabel({ due, resolved }: { due: string | null; resolved: boolean }) {
  const label = fmtDate(due);
  if (!label) return null;
  const d = daysUntilDue(due);
  const overdue = !resolved && d !== null && d < 0;
  const soon = !resolved && d !== null && d >= 0 && d <= 3;
  return (
    <span className={`inline-flex items-center gap-1 ${overdue ? 'text-rose-600 font-medium' : soon ? 'text-amber-600' : 'text-neutral-500'}`}>
      <CalendarClock className="w-3.5 h-3.5" /> {label}
    </span>
  );
}

function ResolutionCard({ r, canUpdate, onUpdateTask }: { r: any; canUpdate: boolean; onUpdateTask: (t: any) => void }) {
  const sum = summariseResolution(r.tasks || []);
  return (
    <Card variant="default" padding="lg">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <Link href={`/legal/board/resolutions/${r.id}`} className="group inline-flex items-center gap-1.5">
            <h3 className="font-semibold text-text-primary group-hover:text-primary-600 truncate">{r.title}</h3>
            <ChevronRight className="w-4 h-4 text-neutral-300 group-hover:text-primary-500" />
          </Link>
          <p className="text-xs text-neutral-500 mt-0.5">
            {r.reference ? `${r.reference} · ` : ''}{r.committee?.name || (r.meeting?.title ? r.meeting.title : 'Board')}
            {r.resolution_date ? ` · ${fmtDate(r.resolution_date)}` : ''}
          </p>
        </div>
        <div className="text-right shrink-0">
          <p className="text-sm font-semibold text-text-primary">{sum.resolved}/{sum.total}</p>
          <p className="text-[11px] uppercase tracking-wider text-neutral-400">resolved</p>
        </div>
      </div>

      {/* Progress bar */}
      {sum.total > 0 && (
        <div className="mt-3 h-1.5 rounded-full bg-neutral-100 overflow-hidden">
          <div className={`h-full rounded-full ${sum.hasOverdue ? 'bg-rose-400' : sum.allResolved ? 'bg-emerald-500' : 'bg-primary-500'}`} style={{ width: `${sum.pct}%` }} />
        </div>
      )}

      {/* Action items */}
      <div className="mt-4 divide-y divide-border/60">
        {(r.tasks || []).length === 0 && <p className="text-sm text-neutral-400 italic py-1">No action items yet.</p>}
        {(r.tasks || []).map((t: any) => {
          const eff = effectiveStatus(t);
          return (
            <div key={t.id} className="flex items-center gap-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="text-sm text-neutral-800 truncate">{t.title}</p>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1 text-xs text-neutral-500">
                  <OwnerLabel task={t} />
                  <DueLabel due={t.due_date} resolved={eff === 'resolved'} />
                </div>
              </div>
              <StatusChip status={eff} />
              {canUpdate && (
                <button onClick={() => onUpdateTask(t)} className="text-xs font-medium text-brand-600 hover:text-brand-700 shrink-0">Update</button>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function ActionBoard({ tasks, canUpdate, onUpdateTask }: { tasks: any[]; canUpdate: boolean; onUpdateTask: (t: any) => void }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
      {EFFECTIVE_STATUSES.map((s) => {
        const col = tasks.filter((t) => t.eff === s);
        const st = TASK_STATUS_STYLES[s];
        return (
          <div key={s} className="rounded-xl bg-neutral-50 border border-border p-2.5">
            <div className="flex items-center justify-between px-1 mb-2">
              <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-neutral-700">
                <span className={`w-2 h-2 rounded-full ${st.dot}`} />{TASK_STATUS_LABELS[s]}
              </span>
              <span className="text-xs text-neutral-400">{col.length}</span>
            </div>
            <div className="space-y-2 min-h-[40px]">
              {col.map((t) => (
                <div key={t.id} className="rounded-lg bg-white border border-border p-2.5 shadow-sm">
                  <Link href={`/legal/board/resolutions/${t.resolution.id}`} className="text-sm text-neutral-800 hover:text-primary-600 line-clamp-2">{t.title}</Link>
                  <p className="text-[11px] text-neutral-400 mt-1 truncate">{t.resolution.title}</p>
                  <div className="flex items-center justify-between mt-2 text-xs text-neutral-500">
                    <OwnerLabel task={t} />
                    {canUpdate && <button onClick={() => onUpdateTask(t)} className="text-brand-600 hover:text-brand-700 font-medium">Update</button>}
                  </div>
                  <div className="mt-1 text-xs"><DueLabel due={t.due_date} resolved={s === 'resolved'} /></div>
                </div>
              ))}
              {col.length === 0 && <p className="text-xs text-neutral-300 text-center py-3">None</p>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export const getServerSideProps: GetServerSideProps = async (context) => {
  const session = await getServerSession(context.req, context.res, authOptions);
  if (!session?.user?.id) return { redirect: { destination: '/', permanent: false } };
  return { props: {} };
};
