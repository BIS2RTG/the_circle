import { useState } from 'react';
import { Modal, Button } from '../../ui';
import { useToast } from '../../ui/ToastProvider';
import OwnerPicker, { OwnerValue } from './OwnerPicker';

/**
 * Add a single action item to an existing resolution. The owner is notified.
 */
export default function AddTaskModal({
  isOpen, onClose, resolutionId, onAdded,
}: {
  isOpen: boolean;
  onClose: () => void;
  resolutionId: string;
  onAdded: () => void;
}) {
  const { addToast } = useToast();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [owner, setOwner] = useState<OwnerValue>({ owner_user_id: null, owner_name: null });
  const [dueDate, setDueDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => { setTitle(''); setDescription(''); setOwner({ owner_user_id: null, owner_name: null }); setDueDate(''); setError(null); };
  const close = () => { reset(); onClose(); };

  const save = async () => {
    setError(null);
    if (!title.trim()) { setError('An action title is required.'); return; }
    setBusy(true);
    try {
      const r = await fetch(`/api/legal/bgm/resolutions/${resolutionId}/tasks`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title.trim(), description: description.trim() || null, owner_user_id: owner.owner_user_id, owner_name: owner.owner_name, due_date: dueDate || null }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Could not add the action.');
      addToast({ type: 'success', message: owner.owner_user_id ? 'Action added and owner notified.' : 'Action added.' });
      onAdded();
      close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const inputCls = 'w-full px-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500';

  return (
    <Modal isOpen={isOpen} onClose={close} title="Add action item" size="md">
      <div className="space-y-4">
        {error && <div className="bg-rose-50 border border-rose-100 rounded-xl px-4 py-2.5 text-sm text-rose-700">{error}</div>}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Action <span className="text-rose-500">*</span></label>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What must be done" className={inputCls} />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Detail <span className="text-neutral-400 font-normal">(optional)</span></label>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} className={`${inputCls} resize-y`} />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Responsible owner</label>
          <OwnerPicker value={owner} onChange={setOwner} />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Deadline</label>
          <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className={inputCls} />
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={close} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={save} isLoading={busy}>Add action</Button>
        </div>
      </div>
    </Modal>
  );
}
