import { useEffect, useState } from 'react';
import { Modal, Button } from '../../ui';
import SignatureSelector, { SignatureSelection } from '../../approvals/SignatureSelector';

/**
 * Sign-off modal for the legal team — the same "use saved signature or draw one"
 * control the rest of the app uses (SignatureSelector), with the shared
 * iPad-safe signing pad. Resolves the chosen signature to a self-contained data
 * URL and hands it to `onSubmit`. Used to finalize the attendance register.
 */
export default function SignOffModal({
  title = 'Sign to confirm', subtitle, confirmLabel = 'Confirm', busy, onSubmit, onClose,
}: {
  title?: string;
  subtitle?: string;
  confirmLabel?: string;
  busy?: boolean;
  onSubmit: (signatureDataUrl: string) => void;
  onClose: () => void;
}) {
  const [savedUrl, setSavedUrl] = useState<string | null>(null);
  const [sel, setSel] = useState<SignatureSelection>({ type: 'saved' });
  const [error, setError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);

  // Fetch the signer's saved signature so "Use saved" is available (as elsewhere).
  useEffect(() => {
    let alive = true;
    fetch('/api/user/signature')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!alive) return;
        const url = d?.signature_url || d?.signature?.url || null;
        setSavedUrl(url);
        setSel({ type: url ? 'saved' : 'manual' });
      })
      .catch(() => { if (alive) setSel({ type: 'manual' }); });
    return () => { alive = false; };
  }, []);

  // Fetch a same-origin image URL and turn it into a self-contained data URL.
  const toDataUrl = async (url: string): Promise<string> => {
    const resp = await fetch(url);
    const blob = await resp.blob();
    return await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result as string);
      fr.onerror = reject;
      fr.readAsDataURL(blob);
    });
  };

  const submit = async () => {
    setError(null);
    if (sel.type === 'saved') {
      if (!savedUrl) { setError('No saved signature on file — draw one instead.'); return; }
      setResolving(true);
      try {
        const dataUrl = await toDataUrl(savedUrl);
        if (!dataUrl.startsWith('data:image')) throw new Error('bad');
        onSubmit(dataUrl);
      } catch { setError('Could not load your saved signature. Please draw one instead.'); }
      finally { setResolving(false); }
      return;
    }
    if (!sel.data) { setError('Please draw your signature in the box.'); return; }
    onSubmit(sel.data);
  };

  return (
    <Modal isOpen onClose={onClose} title={title} size="md">
      <div>
        {subtitle && <p className="text-sm text-neutral-500 mb-3">{subtitle}</p>}
        <SignatureSelector savedSignatureUrl={savedUrl} value={sel} onChange={(s) => { setSel(s); setError(null); }} />
        {error && <p className="mt-2 text-sm text-rose-600">{error}</p>}
        <div className="flex justify-end gap-2 mt-4">
          <Button variant="ghost" onClick={onClose} disabled={busy || resolving}>Cancel</Button>
          <Button variant="primary" onClick={submit} isLoading={busy || resolving}>{confirmLabel}</Button>
        </div>
      </div>
    </Modal>
  );
}
