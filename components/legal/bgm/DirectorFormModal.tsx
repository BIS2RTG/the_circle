import { useState } from 'react';
import { Modal, Button, Input } from '../../ui';
import { useToast } from '../../ui/ToastProvider';
import { Crown, X, UserCheck } from 'lucide-react';
import StaffDirectorySearch from './StaffDirectorySearch';

interface CommitteeOption { id: string; name: string; is_main_board?: boolean }

interface DirectorFormModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Receives the newly-created member so the caller can append it without a refetch. */
  onCreated: (director: any) => void;
  /** Committees the new member can be added to right away. */
  committees?: CommitteeOption[];
}

/** Create a new board member — with optional committee memberships. Editing lives on the director detail page. */
export default function DirectorFormModal({ isOpen, onClose, onCreated, committees = [] }: DirectorFormModalProps) {
  const { addToast } = useToast();
  const [saving, setSaving] = useState(false);
  const [f, setF] = useState({ salutation: '', full_name: '', email: '', phone: '', appointed_date: '', is_hrims: false });
  // committeeId -> isChair
  const [memberships, setMemberships] = useState<Record<string, boolean>>({});

  const reset = () => { setF({ salutation: '', full_name: '', email: '', phone: '', appointed_date: '', is_hrims: false }); setMemberships({}); };
  const close = () => { if (!saving) { reset(); onClose(); } };

  // Toggling HRIMS on/off clears the identity fields so the two entry modes
  // (directory pick vs. manual) don't carry stale values between them.
  const setHrims = (on: boolean) => setF({ ...f, is_hrims: on, salutation: '', full_name: '', email: '' });

  const toggleCommittee = (id: string) => setMemberships((prev) => {
    const next = { ...prev };
    if (id in next) delete next[id]; else next[id] = false;
    return next;
  });
  const toggleChair = (id: string) => setMemberships((prev) => ({ ...prev, [id]: !prev[id] }));

  const submit = async () => {
    if (!f.full_name.trim()) {
      return addToast({ type: 'error', message: f.is_hrims ? 'Pick a staff member from the directory.' : 'Name is required.' });
    }
    const fullName = `${f.salutation ? f.salutation + ' ' : ''}${f.full_name.trim()}`.trim();
    setSaving(true);
    try {
      const res = await fetch('/api/legal/bgm/directors', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          full_name: fullName,
          salutation: f.salutation || null,
          email: f.email || null,
          phone: f.phone || null,
          appointed_date: f.appointed_date || null,
          is_hrims: f.is_hrims ? true : null,
          // Staff picks come from the directory — reuse an existing member rather than erroring.
          get_or_create: f.is_hrims,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to add director');

      // Add committee memberships (best-effort — report if any fail). Fire them
      // in parallel: they're independent and each is a separate round-trip.
      const chosen = Object.entries(memberships);
      const results = await Promise.all(chosen.map(([committeeId, isChair]) =>
        fetch(`/api/legal/bgm/committees/${committeeId}/members`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ director_id: data.id, is_chair: isChair }),
        }).then((r) => r.ok).catch(() => false)
      ));
      const failed = results.filter((ok) => !ok).length;

      if (failed > 0) {
        addToast({ type: 'warning', message: `Board member added, but ${failed} committee assignment(s) failed.` });
      } else if (data.existing) {
        addToast({ type: 'success', message: chosen.length ? `${fullName} is already a board member — added to ${chosen.length} committee(s).` : `${fullName} is already a board member.` });
      } else {
        addToast({ type: 'success', message: chosen.length ? `Board member added to ${chosen.length} committee(s).` : 'Board member added.' });
      }

      // Hand the caller a ready-made director so it can append optimistically —
      // no full re-fetch of the directory + committees needed.
      const assignedCommittees = chosen
        .map(([committeeId, isChair], i) => (results[i]
          ? { id: committeeId, name: committees.find((c) => c.id === committeeId)?.name, is_chair: isChair }
          : null))
        .filter(Boolean);
      reset();
      onCreated({
        id: data.id,
        full_name: fullName,
        email: f.email || null,
        status: 'active',
        committees: assignedCommittees,
      });
    } catch (err) { addToast({ type: 'error', message: (err as Error).message }); }
    finally { setSaving(false); }
  };

  return (
    <Modal isOpen={isOpen} onClose={close} title="Add a member" size="md">
      <div className="space-y-3">
        {/* Staff / HRIMS member — at the very top: it decides how identity is entered. */}
        <label className="flex items-start gap-2.5 cursor-pointer rounded-xl border border-gray-200 bg-neutral-50/60 p-3">
          <input type="checkbox" checked={f.is_hrims} onChange={(e) => setHrims(e.target.checked)}
            className="w-4 h-4 mt-0.5 rounded border-gray-300 text-primary-600 focus:ring-primary-500" />
          <span className="text-sm text-gray-700">Staff / HRIMS member
            <span className="block text-xs text-gray-400">They already have a staff login — pick them from the directory below and they skip the external terms step. Leave unticked for an external board member.</span>
          </span>
        </label>

        {f.is_hrims ? (
          // Directory (AD) pick — name + email come from the staff directory.
          f.full_name ? (
            <div className="flex items-center justify-between gap-2 rounded-xl border border-primary-200 bg-primary-50/50 px-3 py-2.5">
              <div className="min-w-0">
                <p className="text-sm font-medium text-neutral-900 truncate flex items-center gap-1.5"><UserCheck className="w-4 h-4 text-primary-600 shrink-0" />{f.full_name}</p>
                <p className="text-xs text-neutral-500 truncate">{f.email || 'No email on file'}</p>
              </div>
              <button type="button" onClick={() => setF({ ...f, full_name: '', email: '' })} className="p-1 text-neutral-400 hover:text-rose-500" title="Choose someone else"><X className="w-4 h-4" /></button>
            </div>
          ) : (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Find the staff member</label>
              <StaffDirectorySearch autoFocus onPick={(p) => setF({ ...f, full_name: p.name, email: p.email })} />
            </div>
          )
        ) : (
          // Manual entry — external board member.
          <>
            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Title</label>
                <select value={f.salutation} onChange={(e) => setF({ ...f, salutation: e.target.value })}
                  className="w-full px-3 py-2 min-h-[44px] rounded-xl border border-gray-300 bg-white text-gray-900 focus:outline-none focus:ring-2 focus:ring-brand-500">
                  <option value="">—</option>
                  {['Mr.', 'Mrs.', 'Ms.', 'Dr.', 'Prof.', 'Adv.', 'Eng.', 'Hon.'].map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div className="col-span-2">
                <Input label="Full name" value={f.full_name} onChange={(e) => setF({ ...f, full_name: e.target.value })} placeholder="e.g. Jane Moyo" />
              </div>
            </div>
            <Input label="Email" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} placeholder="Needed for meeting invitations" />
          </>
        )}

        <div className="grid grid-cols-2 gap-2">
          <Input label="Phone" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
          <Input label="Appointed" type="date" value={f.appointed_date} onChange={(e) => setF({ ...f, appointed_date: e.target.value })} />
        </div>

        {/* Committee memberships */}
        {committees.length > 0 && (
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Committee memberships <span className="text-gray-400 font-normal">(optional)</span></label>
            <div className="rounded-xl border border-gray-200 divide-y divide-gray-100 max-h-48 overflow-y-auto">
              {committees.map((c) => {
                const selected = c.id in memberships;
                return (
                  <div key={c.id} className="flex items-center justify-between gap-2 px-3 py-2">
                    <label className="flex items-center gap-2.5 cursor-pointer min-w-0">
                      <input type="checkbox" checked={selected} onChange={() => toggleCommittee(c.id)}
                        className="w-4 h-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500" />
                      <span className="text-sm text-gray-800 truncate">{c.name}</span>
                    </label>
                    {selected && (
                      <button type="button" onClick={() => toggleChair(c.id)}
                        className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium border transition-colors shrink-0 ${memberships[c.id] ? 'border-amber-400 bg-amber-50 text-amber-700' : 'border-gray-200 text-neutral-500 hover:bg-neutral-50'}`}>
                        <Crown className="w-3 h-3" /> {memberships[c.id] ? 'Chair' : 'Make chair'}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={close} disabled={saving}>Cancel</Button>
          <Button variant="primary" onClick={submit} isLoading={saving}>Add member</Button>
        </div>
      </div>
    </Modal>
  );
}
