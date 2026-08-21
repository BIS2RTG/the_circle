import { useState } from 'react';
import { Modal, Button } from '../../ui';
import { useToast } from '../../ui/ToastProvider';
import SignatureSelector, { SignatureSelection } from '../../approvals/SignatureSelector';

/**
 * Capture a board member's / guest's attendance signature on the legal admin's
 * device (e.g. an iPad passed around the boardroom). Uses the shared
 * SignatureSelector pad (iPad-safe, same size/behaviour as the rest of the app),
 * draw-only since it's the attendee — not the admin — signing.
 */
export default function SignatureCaptureModal({
  meetingId, attendee, onClose, onSaved,
}: {
  meetingId: string;
  attendee: { id: string; kind: 'director' | 'guest'; name: string };
  onClose: () => void;
  onSaved: () => void;
}) {
  const { addToast } = useToast();
  const [sel, setSel] = useState<SignatureSelection>({ type: 'manual' });
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!sel.data) { addToast({ type: 'error', message: 'Please sign in the box first.' }); return; }
    setSaving(true);
    try {
      const res = await fetch(`/api/legal/bgm/meetings/${meetingId}/sign`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: attendee.kind, id: attendee.id, signature: sel.data }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save signature');
      addToast({ type: 'success', message: `${attendee.name} checked in.` });
      onSaved();
    } catch (err) {
      addToast({ type: 'error', message: (err as Error).message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} title="Sign for attendance" size="md">
      <div>
        <p className="text-sm text-neutral-500">Hand the device to</p>
        <p className="text-lg font-bold text-neutral-900 mb-3">{attendee.name}</p>

        <label className="block text-sm font-medium text-gray-700 mb-1.5">Sign below to confirm attendance</label>
        <SignatureSelector drawOnly value={sel} onChange={setSel} />

        <div className="flex justify-end gap-2 mt-4">
          <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button variant="primary" onClick={save} isLoading={saving}>Save signature</Button>
        </div>
      </div>
    </Modal>
  );
}
