import { useState } from 'react';
import { Modal, Button, Input } from '../../ui';
import { useToast } from '../../ui/ToastProvider';

interface DirectorFormModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreated: () => void;
}

/** Create a new board member. Editing lives on the director detail page. */
export default function DirectorFormModal({ isOpen, onClose, onCreated }: DirectorFormModalProps) {
  const { addToast } = useToast();
  const [saving, setSaving] = useState(false);
  const [f, setF] = useState({ salutation: '', full_name: '', email: '', phone: '', appointed_date: '' });

  const reset = () => setF({ salutation: '', full_name: '', email: '', phone: '', appointed_date: '' });
  const close = () => { if (!saving) { reset(); onClose(); } };

  const submit = async () => {
    if (!f.full_name.trim()) return addToast({ type: 'error', message: 'Name is required.' });
    setSaving(true);
    try {
      const res = await fetch('/api/legal/bgm/directors', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          full_name: `${f.salutation ? f.salutation + ' ' : ''}${f.full_name.trim()}`.trim(),
          salutation: f.salutation || null,
          email: f.email || null,
          phone: f.phone || null,
          appointed_date: f.appointed_date || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to add director');
      addToast({ type: 'success', message: 'Board member added.' });
      reset();
      onCreated();
    } catch (err) { addToast({ type: 'error', message: (err as Error).message }); }
    finally { setSaving(false); }
  };

  return (
    <Modal isOpen={isOpen} onClose={close} title="Add a board member" size="md">
      <div className="space-y-3">
        <div className="grid grid-cols-3 gap-2">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Title</label>
            <select value={f.salutation} onChange={(e) => setF({ ...f, salutation: e.target.value })}
              className="w-full px-3 py-2 min-h-[44px] rounded-xl border border-gray-300 bg-white text-gray-900 focus:outline-none focus:ring-2 focus:ring-brand-500">
              <option value="">—</option>
              {['Mr.', 'Mrs.', 'Ms.', 'Dr.', 'Prof.'].map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div className="col-span-2">
            <Input label="Full name" value={f.full_name} onChange={(e) => setF({ ...f, full_name: e.target.value })} placeholder="e.g. Jane Moyo" />
          </div>
        </div>
        <Input label="Email" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} placeholder="Needed for meeting invitations" />
        <div className="grid grid-cols-2 gap-2">
          <Input label="Phone" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
          <Input label="Appointed" type="date" value={f.appointed_date} onChange={(e) => setF({ ...f, appointed_date: e.target.value })} />
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={close} disabled={saving}>Cancel</Button>
          <Button variant="primary" onClick={submit} isLoading={saving}>Add member</Button>
        </div>
      </div>
    </Modal>
  );
}
