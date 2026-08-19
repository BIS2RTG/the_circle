import { useRef, useState } from 'react';
import SignatureCanvas from 'react-signature-canvas';
import { Modal, Button } from '../../ui';
import { useToast } from '../../ui/ToastProvider';
import DeclarationForm from './DeclarationForm';
import { DeclarationDef } from '@/lib/bgmDeclarations';
import { Eraser, ShieldCheck } from 'lucide-react';

/**
 * Complete a governance declaration on behalf of a director, in person (e.g. the
 * director signs on the secretary's device). Same schema-driven form and
 * attestation as the public signing page; posts to the admin PATCH endpoint.
 */
export default function CompleteDeclarationModal({
  isOpen, onClose, declarationId, def, director, initialData, onCompleted,
}: {
  isOpen: boolean;
  onClose: () => void;
  declarationId: string;
  def: DeclarationDef;
  director: { full_name: string };
  initialData?: Record<string, any>;
  onCompleted: () => void;
}) {
  const { addToast } = useToast();
  const [form, setForm] = useState<Record<string, any>>(initialData || {});
  const [signedName, setSignedName] = useState(director.full_name || '');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sigRef = useRef<SignatureCanvas>(null);

  const submit = async () => {
    setError(null);
    if (!confirmed) { setError('The director must confirm the declaration.'); return; }
    if (!signedName.trim()) { setError('Enter the signing name.'); return; }
    if (!sigRef.current || sigRef.current.isEmpty()) { setError('A signature is required.'); return; }
    const signature = sigRef.current.getCanvas().toDataURL('image/png');
    setBusy(true);
    try {
      const r = await fetch(`/api/legal/bgm/declarations/${declarationId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'complete', form_data: form, signature, signed_name: signedName.trim(), declaration_confirmed: true }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Could not save the declaration.');
      addToast({ type: 'success', message: 'Declaration recorded.' });
      onCompleted();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={`Complete: ${def.title}`} size="full">
      <div className="max-w-2xl mx-auto max-h-[75vh] overflow-y-auto px-0.5">
        <p className="text-sm text-neutral-500 mb-1">Completing on behalf of</p>
        <p className="text-base font-bold text-neutral-900 mb-4">{director.full_name}</p>

        {error && <div className="mb-4 bg-rose-50 border border-rose-100 rounded-xl px-4 py-2.5 text-sm text-rose-700">{error}</div>}

        <DeclarationForm def={def} value={form} onChange={setForm} />

        <div className="mt-7 pt-5 border-t border-neutral-100">
          <div className="flex items-start gap-2.5 rounded-xl bg-primary-50/60 border border-primary-100 p-3.5">
            <ShieldCheck className="w-5 h-5 text-primary-600 shrink-0 mt-0.5" />
            <label className="flex items-start gap-2.5 cursor-pointer">
              <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)}
                className="mt-0.5 w-4 h-4 rounded border-gray-300 text-brand-600 focus:ring-brand-500" />
              <span className="text-sm text-neutral-700">{def.attestation}</span>
            </label>
          </div>

          <label className="block text-sm font-medium text-neutral-700 mt-4 mb-1">Signing name</label>
          <input value={signedName} onChange={(e) => setSignedName(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />

          <label className="block text-sm font-medium text-neutral-700 mt-4 mb-1">Signature</label>
          <div className="border border-neutral-300 rounded-xl bg-white relative">
            <SignatureCanvas ref={sigRef}
              canvasProps={{ className: 'w-full h-44 rounded-xl', style: { touchAction: 'none' } }}
              backgroundColor="rgba(255,255,255,0)" />
            <button onClick={() => sigRef.current?.clear()} title="Clear"
              className="absolute top-2 right-2 p-1.5 rounded-lg bg-white border border-neutral-200 text-neutral-400 hover:text-neutral-700">
              <Eraser className="w-4 h-4" />
            </button>
            <span className="absolute bottom-2 left-3 text-xs text-neutral-300 pointer-events-none">Sign here</span>
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-5">
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={submit} isLoading={busy}>Record declaration</Button>
        </div>
      </div>
    </Modal>
  );
}
