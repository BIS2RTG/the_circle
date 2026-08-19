import { useMemo, useState } from 'react';
import { Modal, Button } from '../../ui';
import { useToast } from '../../ui/ToastProvider';
import { DECLARATION_LIST, DeclarationType } from '@/lib/bgmDeclarations';
import { Mail, MailX, Users, Check } from 'lucide-react';

/**
 * Issue one or more governance declarations. Legal staff pick the declaration
 * type, the director(s), an optional deadline, and whether to email the secure
 * completion link. Supports batch-issuing the same declaration to many directors
 * (e.g. the annual round).
 */
export default function IssueDeclarationModal({
  isOpen, onClose, directors, defaultType, onIssued,
}: {
  isOpen: boolean;
  onClose: () => void;
  directors: { id: string; full_name: string; email: string | null; status: string }[];
  defaultType?: DeclarationType;
  onIssued: () => void;
}) {
  const { addToast } = useToast();
  const [type, setType] = useState<DeclarationType>(defaultType || 'annual_governance');
  const [selected, setSelected] = useState<string[]>([]);
  const [dueDate, setDueDate] = useState('');
  const [periodYear, setPeriodYear] = useState<number>(new Date().getFullYear());
  const [sendEmail, setSendEmail] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const def = useMemo(() => DECLARATION_LIST.find((d) => d.type === type)!, [type]);
  const activeDirectors = useMemo(() => directors.filter((d) => d.status === 'active'), [directors]);

  const reset = () => { setSelected([]); setDueDate(''); setError(null); };
  const close = () => { reset(); onClose(); };

  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const allSelected = selected.length > 0 && selected.length === activeDirectors.length;
  const toggleAll = () => setSelected(allSelected ? [] : activeDirectors.map((d) => d.id));

  const issue = async () => {
    setError(null);
    if (selected.length === 0) { setError('Select at least one director.'); return; }
    setBusy(true);
    let ok = 0, failed = 0, noEmail = 0;
    for (const directorId of selected) {
      try {
        const r = await fetch('/api/legal/bgm/declarations', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            director_id: directorId,
            declaration_type: type,
            due_date: dueDate || null,
            period_year: def.isAnnual ? periodYear : null,
            send_email: sendEmail,
          }),
        });
        const d = await r.json();
        if (!r.ok) { failed++; continue; }
        ok++;
        if (sendEmail && !d.emailed) noEmail++;
      } catch { failed++; }
    }
    setBusy(false);
    if (ok > 0) {
      let msg = `Issued to ${ok} director${ok === 1 ? '' : 's'}.`;
      if (sendEmail) msg += noEmail > 0 ? ` ${ok - noEmail} emailed (${noEmail} had no email on file).` : ' Links emailed.';
      addToast({ type: 'success', message: msg });
      onIssued();
      close();
    } else {
      setError('Could not issue the declaration. Please try again.');
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={close} title="Issue governance declaration" size="lg">
      <div className="space-y-4">
        {/* Type */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">Declaration</label>
          <div className="grid grid-cols-1 gap-2">
            {DECLARATION_LIST.map((d) => (
              <button key={d.type} type="button" onClick={() => setType(d.type)}
                className={`text-left rounded-xl border px-3.5 py-2.5 transition-colors ${type === d.type ? 'border-brand-500 bg-brand-50/50 ring-1 ring-brand-500' : 'border-gray-200 hover:bg-neutral-50'}`}>
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold text-neutral-900">{d.title}</span>
                  {type === d.type && <Check className="w-4 h-4 text-brand-600" />}
                </div>
                <p className="text-xs text-neutral-500 mt-0.5">{d.description}</p>
              </button>
            ))}
          </div>
        </div>

        {/* Directors */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="text-sm font-medium text-gray-700 inline-flex items-center gap-1.5"><Users className="w-4 h-4 text-neutral-400" /> Directors</label>
            <button type="button" onClick={toggleAll} className="text-xs font-medium text-brand-600 hover:text-brand-700">
              {allSelected ? 'Clear all' : 'Select all active'}
            </button>
          </div>
          <div className="max-h-52 overflow-y-auto rounded-xl border border-gray-200 divide-y divide-gray-100">
            {activeDirectors.length === 0 && <p className="px-3 py-6 text-center text-sm text-neutral-400">No active directors.</p>}
            {activeDirectors.map((d) => (
              <label key={d.id} className="flex items-center gap-3 px-3 py-2.5 cursor-pointer hover:bg-neutral-50">
                <input type="checkbox" checked={selected.includes(d.id)} onChange={() => toggle(d.id)}
                  className="w-4 h-4 rounded border-gray-300 text-brand-600 focus:ring-brand-500" />
                <span className="flex-1 text-sm text-neutral-800">{d.full_name}</span>
                {!d.email && <span className="inline-flex items-center gap-1 text-[11px] text-amber-600"><MailX className="w-3.5 h-3.5" /> no email</span>}
              </label>
            ))}
          </div>
          {selected.length > 0 && <p className="mt-1 text-xs text-neutral-500">{selected.length} selected</p>}
        </div>

        {/* Options */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Complete by <span className="text-neutral-400 font-normal">(optional)</span></label>
            <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
          </div>
          {def.isAnnual && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Governance year</label>
              <input type="number" value={periodYear} onChange={(e) => setPeriodYear(parseInt(e.target.value, 10) || new Date().getFullYear())}
                className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
            </div>
          )}
        </div>

        <label className="flex items-center gap-2.5 cursor-pointer">
          <input type="checkbox" checked={sendEmail} onChange={(e) => setSendEmail(e.target.checked)}
            className="w-4 h-4 rounded border-gray-300 text-brand-600 focus:ring-brand-500" />
          <span className="text-sm text-neutral-700 inline-flex items-center gap-1.5">
            {sendEmail ? <Mail className="w-4 h-4 text-neutral-400" /> : <MailX className="w-4 h-4 text-neutral-400" />}
            Email each director their secure completion link now
          </span>
        </label>

        {error && <div className="bg-rose-50 border border-rose-100 rounded-xl px-4 py-2.5 text-sm text-rose-700">{error}</div>}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={close} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={issue} isLoading={busy}>
            Issue {selected.length > 0 ? `(${selected.length})` : ''}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
