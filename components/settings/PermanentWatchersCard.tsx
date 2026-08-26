import { useEffect, useMemo, useRef, useState } from 'react';
import { Card, Button } from '../ui';

interface OrgUser {
  id: string;
  display_name: string;
  email: string;
  job_title?: string | null;
}

interface WatcherRow {
  id: string;
  created_at: string;
  watcher: OrgUser | null;
}

/**
 * Lets a user manage their permanent watchers — people who can read-only view
 * every request this user posts or is an approver on.
 */
export default function PermanentWatchersCard({ currentUserId }: { currentUserId?: string }) {
  const [watchers, setWatchers] = useState<WatcherRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Directory search results (Azure AD-backed, with app_users fallback).
  const [results, setResults] = useState<OrgUser[]>([]);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = async () => {
    try {
      const wRes = await fetch('/api/user/permanent-watchers');
      if (wRes.ok) setWatchers((await wRes.json()).watchers || []);
    } catch {
      setError('Failed to load watchers');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const watchedIds = useMemo(() => new Set(watchers.map((w) => w.watcher?.id).filter(Boolean)), [watchers]);

  // Debounced directory search.
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    const q = search.trim();
    if (q.length < 2) {
      setResults([]);
      return;
    }
    searchTimer.current = setTimeout(async () => {
      try {
        const resp = await fetch(`/api/users/search?q=${encodeURIComponent(q)}`);
        const data = resp.ok ? await resp.json() : { users: [] };
        setResults(data.users || []);
      } catch {
        setResults([]);
      }
    }, 250);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [search]);

  const candidates = useMemo(() => {
    return results
      .filter((u) => u.id !== currentUserId && !watchedIds.has(u.id))
      .slice(0, 6);
  }, [results, watchedIds, currentUserId]);

  const addWatcher = async (watcherId: string) => {
    setBusyId(watcherId);
    setError(null);
    try {
      const res = await fetch('/api/user/permanent-watchers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ watcherId }),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Failed to add watcher');
      setSearch('');
      await load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusyId(null);
    }
  };

  const removeWatcher = async (row: WatcherRow) => {
    setBusyId(row.id);
    setError(null);
    try {
      const res = await fetch(`/api/user/permanent-watchers?id=${row.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error((await res.json()).error || 'Failed to remove watcher');
      await load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Card>
      <h3 className="font-semibold text-gray-900 mb-1">Permanent watchers</h3>
      <p className="text-sm text-gray-500 mb-4">
        People you add here can view every request you post and every request you&apos;re an approver on.
        They have read-only access — they can&apos;t approve, edit, or upload.
      </p>

      {error && <p className="text-sm text-danger-600 mb-3">{error}</p>}

      {loading ? (
        <div className="h-10 bg-gray-50 animate-pulse rounded-lg" />
      ) : (
        <>
          <div className="relative mb-4">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search a colleague by name or email…"
              className="w-full px-3 py-2 rounded-lg border border-gray-300 focus:ring-1 focus:ring-primary-500 outline-none text-sm"
            />
            {candidates.length > 0 && (
              <div className="absolute z-10 mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-lg overflow-hidden">
                {candidates.map((u) => (
                  <button
                    key={u.id}
                    type="button"
                    disabled={busyId === u.id}
                    onClick={() => addWatcher(u.id)}
                    className="w-full text-left px-3 py-2 hover:bg-gray-50 text-sm disabled:opacity-50"
                  >
                    <span className="font-medium text-gray-900">{u.display_name}</span>
                    {u.job_title ? <span className="text-gray-500"> — {u.job_title}</span> : ''}
                    <span className="block text-xs text-gray-400">{u.email}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {watchers.length === 0 ? (
            <p className="text-sm text-gray-400 italic">You haven&apos;t added any permanent watchers.</p>
          ) : (
            <ul className="space-y-2">
              {watchers.map((row) => (
                <li key={row.id} className="flex items-center justify-between px-3 py-2 rounded-lg border border-gray-200">
                  <div>
                    <p className="text-sm font-medium text-gray-900">{row.watcher?.display_name || 'Unknown user'}</p>
                    <p className="text-xs text-gray-400">{row.watcher?.email}</p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-danger-600 border-danger-200 hover:bg-danger-50"
                    disabled={busyId === row.id}
                    onClick={() => removeWatcher(row)}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Card>
  );
}
