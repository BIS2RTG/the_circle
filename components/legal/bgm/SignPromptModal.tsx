import { useRef, useState } from 'react';
import SignatureCanvas from 'react-signature-canvas';
import { Modal, Button } from '../../ui';
import { Eraser } from 'lucide-react';

/**
 * Generic signature prompt. Captures a drawn signature as a data URL and hands
 * it to `onSubmit`. Used for finalizing the register (the finaliser signs off).
 */
export default function SignPromptModal({
  title = 'Sign to confirm', subtitle, confirmLabel = 'Confirm', busy, onSubmit, onClose,
}: {
  title?: string;
  subtitle?: string;
  confirmLabel?: string;
  busy?: boolean;
  onSubmit: (signature: string) => void;
  onClose: () => void;
}) {
  const sigRef = useRef<SignatureCanvas>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    if (!sigRef.current || sigRef.current.isEmpty()) { setError('Please sign in the box first.'); return; }
    onSubmit(sigRef.current.getCanvas().toDataURL('image/png'));
  };

  return (
    <Modal isOpen onClose={onClose} title={title} size="md">
      <div>
        {subtitle && <p className="text-sm text-neutral-500 mb-3">{subtitle}</p>}
        <label className="block text-sm font-medium text-gray-700 mb-1">Signature</label>
        <div className="border border-gray-300 rounded-xl bg-white relative">
          <SignatureCanvas ref={sigRef}
            canvasProps={{ className: 'w-full h-44 rounded-xl', style: { touchAction: 'none' } }}
            backgroundColor="rgba(255,255,255,0)" />
          <button onClick={() => { sigRef.current?.clear(); setError(null); }} title="Clear"
            className="absolute top-2 right-2 p-1.5 rounded-lg bg-white border border-neutral-200 text-neutral-400 hover:text-neutral-700">
            <Eraser className="w-4 h-4" />
          </button>
          <span className="absolute bottom-2 left-3 text-xs text-neutral-300 pointer-events-none">Sign here</span>
        </div>
        {error && <p className="mt-2 text-sm text-rose-600">{error}</p>}
        <div className="flex justify-end gap-2 mt-4">
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={submit} isLoading={busy}>{confirmLabel}</Button>
        </div>
      </div>
    </Modal>
  );
}
