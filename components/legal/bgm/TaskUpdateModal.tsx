import { useState } from 'react';
import { Modal, Button } from '../../ui';
import { useToast } from '../../ui/ToastProvider';
import { TASK_STATUSES, TASK_STATUS_LABELS, TaskStatus } from '@/lib/bgmResolutions';
import { CheckCircle2, Circle, PlayCircle } from 'lucide-react';

const ICONS: Record<TaskStatus, React.ReactNode> = {
  pending: <Circle className="w-4 h-4" />,
  in_progress: <PlayCircle className="w-4 h-4" />,
  resolved: <CheckCircle2 className="w-4 h-4" />,
};

/**
 * Owner/manager quick update of an action item's status + a progress note.
 * The note is appended to the item's progress log and, for owner updates,
 * notifies the resolution's creator.
 */
export default function TaskUpdateModal({
  isOpen, onClose, task, onUpdated,
}: {
  isOpen: boolean;
  onClose: () => void;
  task: { id: string; title: string; status: string; progress_note?: string | null } | null;
  onUpdated: () => void;
}) {
  const { addToast } = useToast();
  const [status, setStatus] = useState<TaskStatus>((task?.status as TaskStatus) || 'pending');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  // Re-sync when a different task is opened.
  const [lastId, setLastId] = useState<string | null>(null);
  if (task && task.id !== lastId) { setLastId(task.id); setStatus((task.status as TaskStatus) || 'pending'); setNote(''); }

  if (!task) return null;

  const save = async () => {
    setBusy(true);
    try {
      const r = await fetch(`/api/legal/bgm/tasks/${task.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, progress_note: note.trim() || undefined }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Could not update the action.');
      addToast({ type: 'success', message: 'Action updated.' });
      onUpdated();
      onClose();
    } catch (e) {
      addToast({ type: 'error', message: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Update action" size="md">
      <div className="space-y-4">
        <div>
          <p className="text-xs uppercase tracking-wider text-neutral-400 mb-1">Action</p>
          <p className="text-sm font-medium text-neutral-900">{task.title}</p>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">Status</label>
          <div className="grid grid-cols-3 gap-2">
            {TASK_STATUSES.map((s) => (
              <button key={s} type="button" onClick={() => setStatus(s)}
                className={`inline-flex items-center justify-center gap-1.5 px-2 py-2 rounded-lg border text-sm font-medium transition-colors ${status === s ? 'border-brand-500 bg-brand-50 text-brand-700 ring-1 ring-brand-500' : 'border-gray-200 text-neutral-600 hover:bg-neutral-50'}`}>
                {ICONS[s]}{TASK_STATUS_LABELS[s]}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Progress note <span className="text-neutral-400 font-normal">(optional)</span></label>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} placeholder="What's the latest?"
            className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 resize-y" />
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={save} isLoading={busy}>Save update</Button>
        </div>
      </div>
    </Modal>
  );
}
