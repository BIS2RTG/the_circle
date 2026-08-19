import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { GetServerSideProps } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '../../../api/auth/[...nextauth]';
import { AppLayout } from '../../../../components/layout';
import { Card, Button } from '../../../../components/ui';
import Loader from '@/components/Loader';
import { useToast } from '../../../../components/ui/ToastProvider';
import ConfirmDialog from '../../../../components/ui/ConfirmDialog';
import AddTaskModal from '../../../../components/legal/bgm/AddTaskModal';
import TaskUpdateModal from '../../../../components/legal/bgm/TaskUpdateModal';
import { useRBAC, useRequirePermission } from '../../../../contexts/RBACContext';
import {
  effectiveStatus, summariseResolution, daysUntilDue,
  TASK_STATUS_LABELS, TASK_STATUS_STYLES, EffectiveStatus,
} from '@/lib/bgmResolutions';
import {
  ArrowLeft, Plus, User, CalendarClock, Gavel, Pencil, Trash2, Archive,
  History, Trash, MessageSquare, ExternalLink,
} from 'lucide-react';

function fmtDate(iso: string | null) {
  if (!iso) return null;
  try { return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' }).format(new Date(iso)); } catch { return null; }
}
function fmtDateTime(iso: string | null) {
  if (!iso) return '';
  try { return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso)); } catch { return ''; }
}

export default function ResolutionDetail() {
  const router = useRouter();
  const { id } = router.query;
  const { addToast } = useToast();
  const { hasPermission } = useRBAC();
  useRequirePermission(['bgm.resolutions.view', 'legal.access']);
  const canManage = hasPermission('bgm.resolutions.manage');
  const canUpdate = hasPermission('bgm.resolutions.update') || canManage;

  const [resolution, setResolution] = useState<any>(null);
  const [tasks, setTasks] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [updateTask, setUpdateTask] = useState<any>(null);
  const [confirmDeleteTask, setConfirmDeleteTask] = useState<any>(null);
  const [confirmDeleteRes, setConfirmDeleteRes] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    const r = await fetch(`/api/legal/bgm/resolutions/${id}`);
    if (r.ok) { const d = await r.json(); setResolution(d.resolution); setTasks(d.tasks || []); }
    else setResolution(null);
    setLoading(false);
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const archive = async (is_archived: boolean) => {
    setBusy(true);
    try {
      const r = await fetch(`/api/legal/bgm/resolutions/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ is_archived }) });
      if (!r.ok) throw new Error((await r.json()).error || 'Failed');
      addToast({ type: 'success', message: is_archived ? 'Resolution archived.' : 'Resolution restored.' });
      load();
    } catch (e) { addToast({ type: 'error', message: (e as Error).message }); }
    finally { setBusy(false); }
  };

  const deleteResolution = async () => {
    setConfirmDeleteRes(false); setBusy(true);
    try {
      const r = await fetch(`/api/legal/bgm/resolutions/${id}`, { method: 'DELETE' });
      if (!r.ok) throw new Error((await r.json()).error || 'Failed');
      addToast({ type: 'success', message: 'Resolution deleted.' });
      router.push('/legal/board/resolutions');
    } catch (e) { addToast({ type: 'error', message: (e as Error).message }); setBusy(false); }
  };

  const deleteTask = async () => {
    const t = confirmDeleteTask; setConfirmDeleteTask(null);
    if (!t) return;
    try {
      const r = await fetch(`/api/legal/bgm/tasks/${t.id}`, { method: 'DELETE' });
      if (!r.ok) throw new Error((await r.json()).error || 'Failed');
      addToast({ type: 'success', message: 'Action removed.' });
      load();
    } catch (e) { addToast({ type: 'error', message: (e as Error).message }); }
  };

  if (loading) return <AppLayout title="Resolution"><div className="py-24 flex justify-center"><Loader /></div></AppLayout>;
  if (!resolution) return <AppLayout title="Resolution"><div className="max-w-3xl mx-auto p-8 text-center text-neutral-500">Resolution not found.</div></AppLayout>;

  const sum = summariseResolution(tasks);

  return (
    <AppLayout title={resolution.title}>
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
        <Link href="/legal/board/resolutions" className="inline-flex items-center gap-1.5 text-sm text-neutral-500 hover:text-neutral-800 mb-4">
          <ArrowLeft className="w-4 h-4" /> Back to Resolutions
        </Link>

        {/* Resolution header */}
        <Card variant="default" padding="lg" className="mb-6">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <div className="w-9 h-9 rounded-lg bg-primary-50 text-primary-600 flex items-center justify-center shrink-0"><Gavel className="w-4 h-4" /></div>
                <div>
                  {resolution.reference && <p className="text-xs font-semibold uppercase tracking-wider text-primary-500">{resolution.reference}</p>}
                  <h1 className="text-xl font-bold text-text-primary">{resolution.title}</h1>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-neutral-500">
                {resolution.category && <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-neutral-100 text-neutral-600 text-xs">{resolution.category}</span>}
                {resolution.resolution_date && <span>Passed {fmtDate(resolution.resolution_date)}</span>}
                {resolution.committee?.name && <span>{resolution.committee.name}</span>}
                {resolution.meeting?.id && (
                  <Link href={`/legal/board/meetings/${resolution.meeting.id}`} className="inline-flex items-center gap-1 text-primary-600 hover:underline">
                    <ExternalLink className="w-3.5 h-3.5" /> {resolution.meeting.title}
                  </Link>
                )}
                {resolution.is_archived && <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-neutral-100 text-neutral-500 text-xs">Archived</span>}
              </div>
            </div>
            <div className="text-right shrink-0">
              <p className="text-lg font-bold text-text-primary">{sum.pct}%</p>
              <p className="text-[11px] uppercase tracking-wider text-neutral-400">complete</p>
            </div>
          </div>

          {resolution.description && <p className="mt-4 text-sm text-neutral-700 whitespace-pre-wrap">{resolution.description}</p>}

          {sum.total > 0 && (
            <div className="mt-4 h-1.5 rounded-full bg-neutral-100 overflow-hidden">
              <div className={`h-full rounded-full ${sum.hasOverdue ? 'bg-rose-400' : sum.allResolved ? 'bg-emerald-500' : 'bg-primary-500'}`} style={{ width: `${sum.pct}%` }} />
            </div>
          )}

          {canManage && (
            <div className="mt-5 pt-4 border-t border-border flex flex-wrap gap-2">
              <Button variant="primary" size="sm" onClick={() => setAddOpen(true)}><Plus className="w-4 h-4 mr-1.5" /> Add action</Button>
              {resolution.is_archived
                ? <Button variant="outline" size="sm" onClick={() => archive(false)} isLoading={busy}><Archive className="w-4 h-4 mr-1.5" /> Restore</Button>
                : <Button variant="outline" size="sm" onClick={() => archive(true)} isLoading={busy}><Archive className="w-4 h-4 mr-1.5" /> Archive</Button>}
              <Button variant="ghost" size="sm" onClick={() => setConfirmDeleteRes(true)} className="text-rose-600 hover:bg-rose-50"><Trash2 className="w-4 h-4 mr-1.5" /> Delete</Button>
            </div>
          )}
        </Card>

        {/* Action items */}
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold text-text-primary">Action items <span className="text-sm font-normal text-neutral-400">({sum.resolved}/{sum.total} resolved)</span></h2>
        </div>

        {tasks.length === 0 ? (
          <Card variant="default" padding="lg" className="text-center text-sm text-neutral-500">
            No action items yet.{canManage && ' Add one to assign a responsible owner and deadline.'}
          </Card>
        ) : (
          <div className="space-y-3">
            {tasks.map((t) => (
              <TaskRow key={t.id} t={t} canUpdate={canUpdate} canManage={canManage}
                onUpdate={() => setUpdateTask(t)} onDelete={() => setConfirmDeleteTask(t)} />
            ))}
          </div>
        )}
      </div>

      <AddTaskModal isOpen={addOpen} onClose={() => setAddOpen(false)} resolutionId={String(id)} onAdded={load} />
      <TaskUpdateModal isOpen={!!updateTask} onClose={() => setUpdateTask(null)} task={updateTask} onUpdated={load} />

      <ConfirmDialog isOpen={!!confirmDeleteTask} onCancel={() => setConfirmDeleteTask(null)} onConfirm={deleteTask}
        title="Remove this action?" message="This permanently removes the action item and its progress log." confirmLabel="Remove" variant="danger" />
      <ConfirmDialog isOpen={confirmDeleteRes} onCancel={() => setConfirmDeleteRes(false)} onConfirm={deleteResolution}
        title="Delete this resolution?" message="This permanently deletes the resolution and all of its action items." confirmLabel="Delete" variant="danger" />
    </AppLayout>
  );
}

function TaskRow({ t, canUpdate, canManage, onUpdate, onDelete }: { t: any; canUpdate: boolean; canManage: boolean; onUpdate: () => void; onDelete: () => void }) {
  const [showLog, setShowLog] = useState(false);
  const eff = effectiveStatus(t) as EffectiveStatus;
  const st = TASK_STATUS_STYLES[eff];
  const owner = t.owner?.display_name || t.owner_name;
  const d = daysUntilDue(t.due_date);
  const overdue = eff === 'overdue';
  const due = fmtDate(t.due_date);

  return (
    <Card variant="default" padding="md" className={overdue ? 'border-rose-200' : ''}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-neutral-900">{t.title}</p>
          {t.description && <p className="text-sm text-neutral-500 mt-0.5">{t.description}</p>}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-xs text-neutral-500">
            <span className="inline-flex items-center gap-1">
              {owner ? <><User className="w-3.5 h-3.5 text-neutral-400" />{owner}</> : <span className="italic text-neutral-400">Unassigned</span>}
            </span>
            {due && (
              <span className={`inline-flex items-center gap-1 ${overdue ? 'text-rose-600 font-medium' : (d !== null && d <= 3 && eff !== 'resolved') ? 'text-amber-600' : ''}`}>
                <CalendarClock className="w-3.5 h-3.5" /> {due}{overdue && d !== null ? ` · ${Math.abs(d)}d overdue` : ''}
              </span>
            )}
            {t.progress_note && (
              <span className="inline-flex items-center gap-1 text-neutral-500"><MessageSquare className="w-3.5 h-3.5" /> {t.progress_note}</span>
            )}
          </div>
        </div>
        <div className="flex flex-col items-end gap-2 shrink-0">
          <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium ${st.bg} ${st.text}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${st.dot}`} />{TASK_STATUS_LABELS[eff]}
          </span>
          <div className="flex items-center gap-2">
            {canUpdate && <button onClick={onUpdate} className="text-xs font-medium text-brand-600 hover:text-brand-700">Update</button>}
            {canManage && <button onClick={onDelete} className="text-neutral-300 hover:text-rose-600" title="Remove action"><Trash className="w-3.5 h-3.5" /></button>}
          </div>
        </div>
      </div>

      {/* Progress log */}
      {(t.updates || []).length > 0 && (
        <div className="mt-3 pt-3 border-t border-border/60">
          <button onClick={() => setShowLog((v) => !v)} className="inline-flex items-center gap-1.5 text-xs font-medium text-neutral-500 hover:text-neutral-800">
            <History className="w-3.5 h-3.5" /> {showLog ? 'Hide' : 'Show'} history ({t.updates.length})
          </button>
          {showLog && (
            <ul className="mt-2 space-y-2">
              {t.updates.map((u: any) => (
                <li key={u.id} className="text-xs text-neutral-500 flex gap-2">
                  <span className="text-neutral-300 shrink-0">{fmtDateTime(u.created_at)}</span>
                  <span>
                    {u.created_by_name || 'Someone'}
                    {u.status ? <> set status to <span className="font-medium text-neutral-700">{TASK_STATUS_LABELS[(u.status as EffectiveStatus)] || u.status}</span></> : ' noted'}
                    {u.note ? <>: “{u.note}”</> : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}

export const getServerSideProps: GetServerSideProps = async (context) => {
  const session = await getServerSession(context.req, context.res, authOptions);
  if (!session?.user?.id) return { redirect: { destination: '/', permanent: false } };
  return { props: {} };
};
