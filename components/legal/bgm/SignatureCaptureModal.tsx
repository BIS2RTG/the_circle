import { useRef, useState } from 'react';
import SignatureCanvas from 'react-signature-canvas';
import { Modal, Button } from '../../ui';
import { useToast } from '../../ui/ToastProvider';
import { Eraser } from 'lucide-react';

/**
 * Capture a board member's / guest's attendance signature on the legal admin's
 * device (e.g. an iPad passed around the boardroom). Records them present with
 * an in-person, signed check-in. The signature is captured as a self-contained
 * data URL and stored against the attendee — it never touches the admin's own
 * signature.
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
  const sigRef = useRef<SignatureCanvas>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!sigRef.current || sigRef.current.isEmpty()) {
      addToast({ type: 'error', message: 'Please sign in the box first.' });
      return;
    }
    const signature = sigRef.current.getCanvas().toDataURL('image/png');
    setSaving(true);
    try {
      const res = await fetch(`/api/legal/bgm/meetings/${meetingId}/sign`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: attendee.kind, id: attendee.id, signature }),
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

        <label className="block text-sm font-medium text-gray-700 mb-1">Sign below to confirm attendance</label>
        <div className="border border-gray-300 rounded-xl bg-white relative">
          <SignatureCanvas
            ref={sigRef}
            canvasProps={{ className: 'w-full h-48 rounded-xl', style: { touchAction: 'none' } }}
            backgroundColor="rgba(255,255,255,0)"
          />
          <button onClick={() => sigRef.current?.clear()} title="Clear"
            className="absolute top-2 right-2 p-1.5 rounded-lg bg-white border border-neutral-200 text-neutral-400 hover:text-neutral-700">
            <Eraser className="w-4 h-4" />
          </button>
          <span className="absolute bottom-2 left-3 text-xs text-neutral-300 pointer-events-none">Sign here</span>
        </div>

        <div className="flex justify-end gap-2 mt-4">
          <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button variant="primary" onClick={save} isLoading={saving}>Save signature</Button>
        </div>
      </div>
    </Modal>
  );
}
