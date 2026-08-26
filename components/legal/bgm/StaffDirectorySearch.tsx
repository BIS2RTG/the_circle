import { useEffect, useRef, useState } from 'react';
import { Search } from 'lucide-react';

export interface StaffPerson { id: string; name: string; email: string; jobTitle?: string | null }

/**
 * Search-as-you-type against the staff directory (Azure AD via
 * /api/users/search) and pick one person. Used to attach a staff / HRIMS board
 * member from the directory instead of typing their name and email by hand.
 */
export default function StaffDirectorySearch({
  placeholder = 'Search the staff directory…',
  excludeEmails,
  onPick,
  autoFocus,
}: {
  placeholder?: string;
  excludeEmails?: Set<string>;
  onPick: (p: StaffPerson) => void;
  autoFocus?: boolean;
}) {
  const [term, setTerm] = useState('');
  const [results, setResults] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    const q = term.trim();
    if (q.length < 2) { setResults([]); return; }
    timer.current = setTimeout(async () => {
      setLoading(true);
      try {
        const resp = await fetch(`/api/users/search?q=${encodeURIComponent(q)}`);
        const data = resp.ok ? await resp.json() : { users: [] };
        const exclude = excludeEmails || new Set<string>();
        setResults((data.users || []).filter((u: any) => u.email && !exclude.has(String(u.email).toLowerCase())));
      } catch { setResults([]); } finally { setLoading(false); }
    }, 250);
    return () => { if (timer.current) clearTimeout(timer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [term]);

  const pick = (u: any) => {
    onPick({ id: u.id, name: u.display_name || u.email, email: u.email, jobTitle: u.job_title });
    setTerm(''); setResults([]);
  };

  return (
    <div>
      <div className="relative">
        <Search className="w-4 h-4 text-neutral-400 absolute left-3 top-1/2 -translate-y-1/2" />
        <input value={term} onChange={(e) => setTerm(e.target.value)} placeholder={placeholder} autoFocus={autoFocus}
          className="w-full pl-9 pr-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
      </div>
      {term.trim().length >= 2 && (
        <div className="mt-1.5 rounded-lg border border-gray-200 divide-y divide-gray-100 overflow-hidden max-h-56 overflow-y-auto">
          {loading && <p className="px-3 py-2.5 text-sm text-neutral-400">Searching the directory…</p>}
          {!loading && results.length === 0 && <p className="px-3 py-2.5 text-sm text-neutral-400">No matches in the staff directory.</p>}
          {results.map((u) => (
            <button key={u.id} type="button" onClick={() => pick(u)}
              className="w-full text-left px-3 py-2 hover:bg-neutral-50 text-sm">
              <span className="font-medium text-neutral-900">{u.display_name || 'Unnamed'}</span>
              {u.job_title ? <span className="text-neutral-500"> — {u.job_title}</span> : ''}
              <span className="block text-xs text-neutral-400">{u.email}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
