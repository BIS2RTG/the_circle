import { useState } from 'react';
import { Modal, Button } from '../../ui';
import { useToast } from '../../ui/ToastProvider';
import OwnerPicker, { OwnerValue } from './OwnerPicker';
import { Plus, Trash2, ListTodo } from 'lucide-react';

interface DraftTask {
  title: string;
  owner: OwnerValue;
  due_date: string;
}

/**
 * Record a board/committee resolution and, in the same step, map it to the
 * action items and responsible owners it spawns. Owners are notified on save.
 */
export default function ResolutionFormModal({
  isOpen, onClose, meetings, committees, onCreated,
}: {
  isOpen: boolean;
  onClose: () => void;
  meetings: { id: string; title: string }[];
  committees: { id: string; name: string }[];
  onCreated: (id: string) => void;
}) {
  const { addToast } = useToast();
  const [title, setTitle] = useState('');
  const [reference, setReference] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('');
  const [resolutionDate, setResolutionDate] = useState('');
  const [meetingId, setMeetingId] = useState('');
  const [committeeId, setCommitteeId] = useState('');
  const [tasks, setTasks] = useState<DraftTask[]>([{ title: '', owner: { owner_user_id: null, owner_name: null }, due_date: '' }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setTitle(''); setReference(''); setDescription(''); setCategory(''); setResolutionDate('');
    setMeetingId(''); setCommitteeId(''); setTasks([{ title: '', owner: { owner_user_id: null, owner_name: null }, due_date: '' }]); setError(null);
  };
  const close = () => { reset(); onClose(); };

  const setTask = (i: number, patch: Partial<DraftTask>) => setTasks((ts) => ts.map((t, idx) => (idx === i ? { ...t, ...patch } : t)));
  const addTask = () => setTasks((ts) => [...ts, { title: '', owner: { owner_user_id: null, owner_name: null }, due_date: '' }]);
  const removeTask = (i: number) => setTasks((ts) => ts.filter((_, idx) => idx !== i));

  const save = async () => {
    setError(null);
    if (!title.trim()) { setError('A resolution title is required.'); return; }
    const cleanTasks = tasks
      .filter((t) => t.title.trim())
      .map((t) => ({ title: t.title.trim(), owner_user_id: t.owner.owner_user_id, owner_name: t.owner.owner_name, due_date: t.due_date || null }));

    setBusy(true);
    try {
      const r = await fetch('/api/legal/bgm/resolutions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(), reference: reference.trim() || null, description: description.trim() || null,
          category: category.trim() || null, resolution_date: resolutionDate || null,
          meeting_id: meetingId || null, committee_id: committeeId || null, tasks: cleanTasks,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Could not save the resolution.');
      addToast({ type: 'success', message: `Resolution recorded${cleanTasks.length ? ` with ${cleanTasks.length} action${cleanTasks.length === 1 ? '' : 's'}` : ''}.` });
      onCreated(d.id);
      close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const inputCls = 'w-full px-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500';

  return (
    <Modal isOpen={isOpen} onClose={close} title="Record board resolution" size="full">
      <div className="max-w-2xl mx-auto max-h-[75vh] overflow-y-auto px-0.5 space-y-4">
        {error && <div className="bg-rose-50 border border-rose-100 rounded-xl px-4 py-2.5 text-sm text-rose-700">{error}</div>}

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Resolution <span className="text-rose-500">*</span></label>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Approval of the FY2026 capital budget" className={inputCls} />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Reference</label>
            <input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="RES-2026-014" className={inputCls} />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Category</label>
            <input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Finance / Strategy / Governance…" className={inputCls} />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Resolution text</label>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} placeholder="As minuted…" className={`${inputCls} resize-y`} />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Date passed</label>
            <input type="date" value={resolutionDate} onChange={(e) => setResolutionDate(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Meeting</label>
            <select value={meetingId} onChange={(e) => setMeetingId(e.target.value)} className={inputCls}>
              <option value="">—</option>
              {meetings.map((m) => <option key={m.id} value={m.id}>{m.title}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Committee</label>
            <select value={committeeId} onChange={(e) => setCommitteeId(e.target.value)} className={inputCls}>
              <option value="">—</option>
              {committees.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        </div>

        {/* Action items */}
        <div className="pt-2">
          <div className="flex items-center gap-2 mb-2">
            <ListTodo className="w-4 h-4 text-neutral-400" />
            <h3 className="text-sm font-semibold text-neutral-900">Action items</h3>
            <span className="text-xs text-neutral-400">— map this resolution to responsible owners</span>
          </div>
          <div className="space-y-3">
            {tasks.map((t, i) => (
              <div key={i} className="rounded-xl border border-gray-200 bg-neutral-50/60 p-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-semibold uppercase tracking-wider text-neutral-400">Action {i + 1}</span>
                  {tasks.length > 1 && (
                    <button type="button" onClick={() => removeTask(i)} className="text-neutral-400 hover:text-rose-600"><Trash2 className="w-4 h-4" /></button>
                  )}
                </div>
                <input value={t.title} onChange={(e) => setTask(i, { title: e.target.value })} placeholder="What must be done" className={`${inputCls} mb-2`} />
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <div>
                    <label className="block text-xs text-neutral-500 mb-1">Responsible owner</label>
                    <OwnerPicker value={t.owner} onChange={(v) => setTask(i, { owner: v })} />
                  </div>
                  <div>
                    <label className="block text-xs text-neutral-500 mb-1">Deadline</label>
                    <input type="date" value={t.due_date} onChange={(e) => setTask(i, { due_date: e.target.value })} className={inputCls} />
                  </div>
                </div>
              </div>
            ))}
          </div>
          <button type="button" onClick={addTask} className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-brand-600 hover:text-brand-700">
            <Plus className="w-4 h-4" /> Add action item
          </button>
        </div>

        <div className="flex justify-end gap-2 pt-2 border-t border-gray-100">
          <Button variant="ghost" onClick={close} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={save} isLoading={busy}>Record resolution</Button>
        </div>
      </div>
    </Modal>
  );
}
