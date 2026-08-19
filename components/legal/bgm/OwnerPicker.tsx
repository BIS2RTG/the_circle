import { useEffect, useRef, useState } from 'react';
import { Search, X, User } from 'lucide-react';

export interface OwnerValue {
  owner_user_id: string | null;
  owner_name: string | null;
}

/**
 * Single responsible-owner picker for resolution action items. Searches
 * app_users via /api/users/search; also accepts a free-text name for an owner
 * who isn't a system user. Mirrors AssociatesField's directory behaviour.
 */
export default function OwnerPicker({ value, onChange, disabled }: { value: OwnerValue; onChange: (v: OwnerValue) => void; disabled?: boolean }) {
  const [term, setTerm] = useState('');
  const [results, setResults] = useState<{ id: string; display_name: string; email: string; job_title: string | null }[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  useEffect(() => {
    if (!term.trim() || term.trim().length < 1) { setResults([]); return; }
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const r = await fetch(`/api/users/search?q=${encodeURIComponent(term.trim())}`);
        if (r.ok) setResults((await r.json()).users || []);
      } catch { /* ignore */ }
      setLoading(false);
    }, 250);
    return () => clearTimeout(t);
  }, [term]);

  const pickUser = (u: { id: string; display_name: string; email: string }) => {
    onChange({ owner_user_id: u.id, owner_name: u.display_name || u.email });
    setTerm(''); setResults([]); setOpen(false);
  };
  const pickFreeText = () => {
    const name = term.trim();
    if (!name) return;
    onChange({ owner_user_id: null, owner_name: name });
    setTerm(''); setResults([]); setOpen(false);
  };
  const clear = () => onChange({ owner_user_id: null, owner_name: null });

  if (value.owner_name) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-gray-200 bg-neutral-50 px-3 py-2">
        <div className="w-6 h-6 rounded-full bg-primary-100 text-primary-600 flex items-center justify-center shrink-0">
          <User className="w-3.5 h-3.5" />
        </div>
        <span className="flex-1 text-sm text-neutral-800">{value.owner_name}</span>
        {!value.owner_user_id && <span className="text-[10px] text-neutral-400 uppercase tracking-wide">external</span>}
        {!disabled && <button type="button" onClick={clear} className="text-neutral-400 hover:text-rose-600"><X className="w-4 h-4" /></button>}
      </div>
    );
  }

  return (
    <div ref={boxRef} className="relative">
      <div className="relative">
        <Search className="w-4 h-4 text-neutral-400 absolute left-3 top-1/2 -translate-y-1/2" />
        <input
          value={term} disabled={disabled}
          onChange={(e) => { setTerm(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (results[0]) pickUser(results[0]); else pickFreeText(); } }}
          placeholder="Search people or type a name…"
          className="w-full pl-9 pr-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
      </div>
      {open && term.trim() && (
        <div className="absolute z-20 mt-1 w-full bg-white rounded-xl border border-gray-200 shadow-lg overflow-hidden">
          {loading && <p className="px-3 py-2.5 text-sm text-neutral-400">Searching…</p>}
          {!loading && results.map((u) => (
            <button key={u.id} type="button" onClick={() => pickUser(u)}
              className="w-full text-left px-3 py-2 hover:bg-neutral-50 flex items-center gap-2.5">
              <div className="w-7 h-7 rounded-full bg-primary-100 text-primary-600 flex items-center justify-center shrink-0"><User className="w-3.5 h-3.5" /></div>
              <div className="min-w-0">
                <p className="text-sm text-neutral-800 truncate">{u.display_name}</p>
                <p className="text-xs text-neutral-400 truncate">{u.job_title || u.email}</p>
              </div>
            </button>
          ))}
          {!loading && (
            <button type="button" onClick={pickFreeText}
              className="w-full text-left px-3 py-2 hover:bg-neutral-50 border-t border-gray-100 text-sm text-neutral-600">
              Use “<span className="font-medium text-neutral-800">{term.trim()}</span>” as an external owner
            </button>
          )}
        </div>
      )}
    </div>
  );
}
