import { useEffect, useMemo, useState } from 'react';
import { Modal, Button } from '../../ui';
import { useToast } from '../../ui/ToastProvider';
import { Crown, X, UserPlus, Search, Check, Landmark } from 'lucide-react';
import StaffDirectorySearch from './StaffDirectorySearch';

interface Member { id: string; full_name: string; salutation: string | null; status: string; is_chair: boolean }

/**
 * Manage a committee's composition: add/remove members, set the chair, and add a
 * brand-new person inline. Members are drawn from the board's directors pool.
 */
export default function ManageCommitteeModal({
  isOpen, onClose, committee, directors, onChanged,
}: {
  isOpen: boolean;
  onClose: () => void;
  committee: { id: string; name: string; is_main_board?: boolean } | null;
  directors: { id: string; full_name: string; salutation: string | null; status: string }[];
  onChanged: () => void;
}) {
  const { addToast } = useToast();
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [term, setTerm] = useState('');
  const [adding, setAdding] = useState(false);
  const [newPerson, setNewPerson] = useState<{ open: boolean; salutation: string; name: string }>({ open: false, salutation: '', name: '' });

  const load = async () => {
    if (!committee) return;
    setLoading(true);
    const r = await fetch(`/api/legal/bgm/committees/${committee.id}/members`);
    if (r.ok) setMembers((await r.json()).members || []);
    setLoading(false);
  };

  useEffect(() => { if (isOpen && committee) { setTerm(''); setNewPerson({ open: false, salutation: '', name: '' }); load(); } /* eslint-disable-next-line */ }, [isOpen, committee?.id]);

  const memberIds = useMemo(() => new Set(members.map((m) => m.id)), [members]);
  const candidates = useMemo(() => {
    const q = term.trim().toLowerCase();
    return directors
      .filter((d) => d.status === 'active' && !memberIds.has(d.id))
      .filter((d) => !q || d.full_name.toLowerCase().includes(q))
      .slice(0, 8);
  }, [directors, memberIds, term]);

  const patch = async (method: string, body?: any, query = '') => {
    if (!committee) return;
    const r = await fetch(`/api/legal/bgm/committees/${committee.id}/members${query}`, {
      method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined,
    });
    const d = await r.json();
    if (!r.ok) { addToast({ type: 'error', message: d.error || 'Update failed.' }); return false; }
    if (d.members) setMembers(d.members);
    onChanged();
    return true;
  };

  const addMember = async (directorId: string) => { setBusy(directorId); await patch('POST', { director_id: directorId }); setBusy(null); setTerm(''); };
  const removeMember = async (directorId: string) => { setBusy(directorId); await patch('DELETE', undefined, `?director_id=${directorId}`); setBusy(null); };
  const setChair = async (directorId: string, isChair: boolean) => { setBusy('chair' + directorId); await patch('PATCH', { director_id: directorId, is_chair: isChair }); setBusy(null); };

  // Add a staff member picked from the AD directory: reuse them if they're
  // already a board member (get_or_create), else create the director, then add
  // them to this committee.
  const addFromStaff = async (p: { name: string; email: string }) => {
    setAdding(true);
    try {
      const res = await fetch('/api/legal/bgm/directors', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ full_name: p.name, email: p.email || null, is_hrims: true, get_or_create: true }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not add the staff member.');
      const ok = await patch('POST', { director_id: data.id });
      if (ok) addToast({ type: 'success', message: `${p.name} added to committee.` });
    } catch (e) { addToast({ type: 'error', message: (e as Error).message }); }
    finally { setAdding(false); }
  };

  const addNewPerson = async () => {
    const name = newPerson.name.trim();
    if (!name) { addToast({ type: 'error', message: 'Enter a name.' }); return; }
    setAdding(true);
    try {
      const res = await fetch('/api/legal/bgm/directors', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ full_name: `${newPerson.salutation ? newPerson.salutation + ' ' : ''}${name}`.trim(), salutation: newPerson.salutation || null }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not add the person.');
      await patch('POST', { director_id: data.id });
      setNewPerson({ open: false, salutation: '', name: '' });
      addToast({ type: 'success', message: 'Added to committee.' });
    } catch (e) { addToast({ type: 'error', message: (e as Error).message }); }
    finally { setAdding(false); }
  };

  if (!committee) return null;
  const chair = members.find((m) => m.is_chair);

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Manage committee" size="lg">
      <div>
        <div className="flex items-center gap-2 mb-4">
          <div className="w-9 h-9 rounded-lg bg-primary-50 text-primary-600 flex items-center justify-center shrink-0"><Landmark className="w-4 h-4" /></div>
          <div>
            <p className="font-semibold text-neutral-900">{committee.name}</p>
            <p className="text-xs text-neutral-500">{members.length} member{members.length === 1 ? '' : 's'}{chair ? ` · Chair: ${chair.full_name}` : ' · No chair set'}</p>
          </div>
        </div>

        {/* Members */}
        <div className="rounded-xl border border-gray-200 divide-y divide-gray-100 max-h-64 overflow-y-auto mb-4">
          {loading ? (
            <p className="px-3 py-6 text-center text-sm text-neutral-400">Loading…</p>
          ) : members.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-neutral-400">No members yet.</p>
          ) : members.map((m) => (
            <div key={m.id} className="flex items-center gap-2 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="text-sm text-neutral-800 truncate flex items-center gap-1.5">
                  {m.is_chair && <Crown className="w-3.5 h-3.5 text-amber-500 shrink-0" />}{m.full_name}
                </p>
              </div>
              <button onClick={() => setChair(m.id, !m.is_chair)} disabled={busy === 'chair' + m.id}
                className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium border transition-colors ${m.is_chair ? 'border-amber-400 bg-amber-50 text-amber-700' : 'border-gray-200 text-neutral-500 hover:bg-neutral-50'}`}>
                <Crown className="w-3 h-3" /> {m.is_chair ? 'Chair' : 'Make chair'}
              </button>
              <button onClick={() => removeMember(m.id)} disabled={busy === m.id} title="Remove" className="text-neutral-400 hover:text-rose-600 p-1"><X className="w-4 h-4" /></button>
            </div>
          ))}
        </div>

        {/* Add existing director */}
        <div className="mb-3">
          <label className="block text-sm font-medium text-gray-700 mb-1.5">Add a member</label>
          <div className="relative">
            <Search className="w-4 h-4 text-neutral-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Search board & committee members…"
              className="w-full pl-9 pr-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
          </div>
          {term.trim() && (
            <div className="mt-1.5 rounded-lg border border-gray-200 divide-y divide-gray-100 overflow-hidden">
              {candidates.length === 0 ? (
                <p className="px-3 py-2.5 text-sm text-neutral-400">No matches. Add a new person below.</p>
              ) : candidates.map((d) => (
                <button key={d.id} onClick={() => addMember(d.id)} disabled={busy === d.id}
                  className="w-full text-left px-3 py-2 hover:bg-neutral-50 flex items-center justify-between text-sm">
                  <span className="text-neutral-800">{d.full_name}</span>
                  {busy === d.id ? <Check className="w-4 h-4 text-emerald-500" /> : <UserPlus className="w-4 h-4 text-neutral-400" />}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Add a staff member from the directory (Azure AD) */}
        <div className="mb-3">
          <label className="block text-sm font-medium text-gray-700 mb-1.5">…or add a staff member from the directory</label>
          <StaffDirectorySearch placeholder="Search the staff directory (AD)…" onPick={(p) => addFromStaff({ name: p.name, email: p.email })} />
        </div>

        {/* Add a brand-new person */}
        {!newPerson.open ? (
          <button onClick={() => setNewPerson({ ...newPerson, open: true })} className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-600 hover:text-brand-700">
            <UserPlus className="w-4 h-4" /> Add a new person
          </button>
        ) : (
          <div className="rounded-xl border border-gray-200 bg-neutral-50/60 p-3">
            <p className="text-xs font-medium text-neutral-600 mb-2">New committee member</p>
            <div className="flex gap-2">
              <select value={newPerson.salutation} onChange={(e) => setNewPerson({ ...newPerson, salutation: e.target.value })}
                className="w-24 px-2 py-2 rounded-lg border border-gray-200 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-500">
                <option value="">—</option>
                {['Mr.', 'Mrs.', 'Ms.', 'Dr.', 'Prof.', 'Adv.', 'Eng.', 'Hon.'].map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <input value={newPerson.name} onChange={(e) => setNewPerson({ ...newPerson, name: e.target.value })} placeholder="Full name"
                onKeyDown={(e) => { if (e.key === 'Enter') addNewPerson(); }}
                className="flex-1 px-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
              <Button variant="primary" size="sm" onClick={addNewPerson} isLoading={adding}>Add</Button>
            </div>
          </div>
        )}

        <div className="flex justify-end mt-5">
          <Button variant="ghost" onClick={onClose}>Done</Button>
        </div>
      </div>
    </Modal>
  );
}
