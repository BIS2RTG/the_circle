import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Card, Button } from '../ui';

interface OrgUser {
  id: string;
  display_name: string | null;
  email: string;
  job_title?: string | null;
}

interface Assignment {
  id: string;
  assistant_id: string;
  principal_id: string;
  can_file: boolean;
  can_upload: boolean;
  can_edit: boolean;
  can_withdraw: boolean;
  can_manage_notifications: boolean;
  can_gatekeep: boolean;
  assistant: OrgUser | null;
  principal: OrgUser | null;
}

interface WatchRow {
  id: string;
  owner_id: string;
  watcher_id: string;
  created_by: string | null;
  owner: OrgUser | null;
  watcher: OrgUser | null;
}

/** Merged per-principal capability state for one assistant. */
interface PrincipalCaps {
  principal: OrgUser;
  can_file: boolean;
  can_upload: boolean;
  can_edit: boolean;
  can_withdraw: boolean;
  can_manage_notifications: boolean;
  can_gatekeep: boolean;
  can_watch: boolean;
}

interface AssistantGroup {
  assistant: OrgUser;
  principals: Map<string, PrincipalCaps>;
}

/** The capabilities, in display order. `watch` is stored in permanent_watchers. */
const CAPS: { key: keyof PrincipalCaps; label: string; short: string }[] = [
  { key: 'can_file', label: 'File on their behalf', short: 'File' },
  { key: 'can_watch', label: 'Watch their requests', short: 'Watch' },
  { key: 'can_upload', label: 'Upload documents', short: 'Upload' },
  { key: 'can_edit', label: 'Edit / amend', short: 'Edit' },
  { key: 'can_withdraw', label: 'Withdraw / resubmit', short: 'Withdraw' },
  { key: 'can_manage_notifications', label: 'Receive notifications', short: 'Notif' },
  { key: 'can_gatekeep', label: 'Screen approvals before them', short: 'Screen' },
];

/** Debounced Azure-AD-backed user search (falls back to app_users server-side). */
function ADUserSearch({
  placeholder,
  excludeIds,
  onPick,
}: {
  placeholder: string;
  excludeIds: Set<string>;
  onPick: (u: OrgUser) => void;
}) {
  const [term, setTerm] = useState('');
  const [results, setResults] = useState<OrgUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [source, setSource] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    const q = term.trim();
    if (q.length < 2) {
      setResults([]);
      setSource(null);
      return;
    }
    timer.current = setTimeout(async () => {
      setLoading(true);
      try {
        const resp = await fetch(`/api/users/search?q=${encodeURIComponent(q)}`);
        const data = resp.ok ? await resp.json() : { users: [], source: null };
        setResults((data.users || []).filter((u: OrgUser) => !excludeIds.has(u.id)));
        setSource(data.source || null);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [term, excludeIds]);

  return (
    <div className="relative">
      <input
        type="text"
        value={term}
        onChange={(e) => setTerm(e.target.value)}
        placeholder={placeholder}
        className="w-full px-3 py-2 rounded-lg border border-gray-300 focus:ring-1 focus:ring-primary-500 outline-none text-sm"
      />
      {(results.length > 0 || loading) && term.trim().length >= 2 && (
        <div className="absolute z-10 mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-lg overflow-hidden">
          {loading && <div className="px-3 py-2 text-xs text-gray-400">Searching the directory…</div>}
          {results.map((u) => (
            <button
              key={u.id}
              type="button"
              onClick={() => {
                onPick(u);
                setTerm('');
                setResults([]);
              }}
              className="w-full text-left px-3 py-2 hover:bg-gray-50 text-sm"
            >
              <span className="font-medium text-gray-900">{u.display_name || 'Unnamed'}</span>
              {u.job_title ? <span className="text-gray-500"> — {u.job_title}</span> : ''}
              <span className="block text-xs text-gray-400">{u.email}</span>
            </button>
          ))}
          {!loading && results.length === 0 && (
            <div className="px-3 py-2 text-xs text-gray-400">No matches</div>
          )}
        </div>
      )}
      {source === 'app_users' && term.trim().length >= 2 && (
        <p className="text-[11px] text-gray-400 mt-1">
          Searching the local user list. Live Azure AD search activates when configured.
        </p>
      )}
    </div>
  );
}

/**
 * Admin surface for assistant assignments (records-first).
 *
 * Immediately lists every existing assignment grouped by assistant — making it
 * clear when one assistant acts for multiple people. Selectors search Azure AD.
 * Each assistant→principal row exposes six capability toggles; five live on
 * `assistant_assignments`, "watch" lives on `permanent_watchers`.
 */
export default function AssistantAssignmentsCard() {
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [watchRows, setWatchRows] = useState<WatchRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  // The assistant currently being edited (may have zero principals yet).
  const [editing, setEditing] = useState<OrgUser | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [aRes, wRes] = await Promise.all([
        fetch('/api/admin/assistant-assignments'),
        fetch('/api/admin/permanent-watchers'),
      ]);
      setAssignments(aRes.ok ? (await aRes.json()).assignments || [] : []);
      setWatchRows(wRes.ok ? (await wRes.json()).watchers || [] : []);
    } catch {
      setError('Failed to load assignments');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Merge assignments + admin watcher rows into per-assistant groups.
  const groups = useMemo(() => {
    const map = new Map<string, AssistantGroup>();
    const ensure = (assistant: OrgUser) => {
      if (!map.has(assistant.id)) map.set(assistant.id, { assistant, principals: new Map() });
      return map.get(assistant.id)!;
    };
    const ensurePrincipal = (g: AssistantGroup, principal: OrgUser): PrincipalCaps => {
      if (!g.principals.has(principal.id)) {
        g.principals.set(principal.id, {
          principal,
          can_file: false,
          can_upload: false,
          can_edit: false,
          can_withdraw: false,
          can_manage_notifications: false,
          can_gatekeep: false,
          can_watch: false,
        });
      }
      return g.principals.get(principal.id)!;
    };

    for (const a of assignments) {
      if (!a.assistant || !a.principal) continue;
      const g = ensure(a.assistant);
      const p = ensurePrincipal(g, a.principal);
      p.can_file = a.can_file;
      p.can_upload = a.can_upload;
      p.can_edit = a.can_edit;
      p.can_withdraw = a.can_withdraw;
      p.can_manage_notifications = a.can_manage_notifications;
      p.can_gatekeep = a.can_gatekeep;
    }
    // Admin watcher rows (watcher = assistant, owner = principal). The endpoint
    // already returns only admin-managed rows, so no origin heuristic here.
    for (const w of watchRows) {
      if (!w.watcher || !w.owner) continue;
      const g = ensure(w.watcher);
      const p = ensurePrincipal(g, w.owner);
      p.can_watch = true;
    }
    return Array.from(map.values()).sort((x, y) =>
      (x.assistant.display_name || '').localeCompare(y.assistant.display_name || '')
    );
  }, [assignments, watchRows]);

  // The group being edited (live from `groups`, or an empty shell for a new one).
  const editingGroup: AssistantGroup | null = useMemo(() => {
    if (!editing) return null;
    return groups.find((g) => g.assistant.id === editing.id) || { assistant: editing, principals: new Map() };
  }, [editing, groups]);

  const persistCaps = async (assistantId: string, principalId: string, caps: PrincipalCaps) => {
    const key = `${assistantId}:${principalId}:caps`;
    setBusyKey(key);
    setError(null);
    try {
      const res = await fetch('/api/admin/assistant-assignments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assistantId,
          principalId,
          can_file: caps.can_file,
          can_upload: caps.can_upload,
          can_edit: caps.can_edit,
          can_withdraw: caps.can_withdraw,
          can_manage_notifications: caps.can_manage_notifications,
          can_gatekeep: caps.can_gatekeep,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Failed to update');
      await load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusyKey(null);
    }
  };

  const persistWatch = async (assistantId: string, principalId: string, on: boolean) => {
    const key = `${assistantId}:${principalId}:watch`;
    setBusyKey(key);
    setError(null);
    try {
      const res = on
        ? await fetch('/api/admin/permanent-watchers', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ownerId: principalId, watcherId: assistantId }),
          })
        : await fetch(`/api/admin/permanent-watchers?ownerId=${principalId}&watcherId=${assistantId}`, {
            method: 'DELETE',
          });
      if (!res.ok) throw new Error((await res.json()).error || 'Failed to update');
      await load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusyKey(null);
    }
  };

  const toggleCap = (g: AssistantGroup, p: PrincipalCaps, capKey: keyof PrincipalCaps, next: boolean) => {
    if (capKey === 'can_watch') {
      persistWatch(g.assistant.id, p.principal.id, next);
    } else {
      persistCaps(g.assistant.id, p.principal.id, { ...p, [capKey]: next });
    }
  };

  const addPrincipal = (g: AssistantGroup, principal: OrgUser) => {
    // New principals default to file-on-behalf ON.
    persistCaps(g.assistant.id, principal.id, {
      principal,
      can_file: true,
      can_upload: false,
      can_edit: false,
      can_withdraw: false,
      can_manage_notifications: false,
      can_gatekeep: false,
      can_watch: false,
    });
  };

  const removePrincipal = async (g: AssistantGroup, p: PrincipalCaps) => {
    const key = `${g.assistant.id}:${p.principal.id}:remove`;
    setBusyKey(key);
    setError(null);
    try {
      await Promise.all([
        fetch(`/api/admin/assistant-assignments?assistantId=${g.assistant.id}&principalId=${p.principal.id}`, { method: 'DELETE' }),
        p.can_watch
          ? fetch(`/api/admin/permanent-watchers?ownerId=${p.principal.id}&watcherId=${g.assistant.id}`, { method: 'DELETE' })
          : Promise.resolve(),
      ]);
      await load();
    } catch {
      setError('Failed to remove');
    } finally {
      setBusyKey(null);
    }
  };

  const chipsFor = (p: PrincipalCaps) =>
    CAPS.filter((c) => p[c.key]).map((c) => c.short);

  return (
    <Card>
      <div className="flex items-start justify-between gap-3 mb-1">
        <h3 className="font-semibold text-gray-900">Assistants &amp; delegates</h3>
        {!editing && (
          <Button variant="secondary" size="sm" onClick={() => setEditing({ id: '', display_name: '', email: '' } as any)}>
            + Add assistant
          </Button>
        )}
      </div>
      <p className="text-sm text-gray-500 mb-4">
        Assign an assistant to act for specific people. An assistant can act for multiple people, each with
        their own capabilities. The assistant is the filer of record and receives the approval updates; the
        person they file for is notified once the request is fully approved.
        <span className="block mt-1">
          <strong>Screen approvals before them</strong> routes that person&apos;s incoming approval
          notifications and emails to the assistant first — the assistant reviews each request and either
          forwards it to them or returns it to the requestor with a comment.
        </span>
      </p>

      {error && <p className="text-sm text-danger-600 mb-3">{error}</p>}

      {/* ---- Editor ---- */}
      {editing && (
        <div className="mb-6 p-4 rounded-xl border border-primary-200 bg-primary-50/40">
          {!editing.id ? (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Choose an assistant</label>
              <ADUserSearch
                placeholder="Search the directory by name or email…"
                excludeIds={new Set()}
                onPick={(u) => setEditing(u)}
              />
              <div className="mt-3">
                <Button variant="outline" size="sm" onClick={() => setEditing(null)}>Cancel</Button>
              </div>
            </div>
          ) : editingGroup ? (
            <div>
              <div className="flex items-center justify-between mb-3">
                <div>
                  <p className="text-sm font-semibold text-gray-900">{editing.display_name || editing.email}</p>
                  <p className="text-xs text-gray-400">{editing.email}</p>
                </div>
                <Button variant="outline" size="sm" onClick={() => setEditing(null)}>Done</Button>
              </div>

              <label className="block text-sm font-medium text-gray-700 mb-1">Add a person they act for</label>
              <ADUserSearch
                placeholder="Search the directory by name or email…"
                excludeIds={new Set<string>([editing.id, ...Array.from(editingGroup.principals.keys())])}
                onPick={(u) => addPrincipal(editingGroup, u)}
              />

              {editingGroup.principals.size === 0 ? (
                <p className="text-sm text-gray-400 italic mt-4">No people assigned yet — add one above.</p>
              ) : (
                <ul className="mt-4 space-y-3">
                  {Array.from(editingGroup.principals.values()).map((p) => (
                    <li key={p.principal.id} className="p-3 rounded-lg border border-gray-200 bg-white">
                      <div className="flex items-center justify-between mb-2">
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-gray-900 truncate">{p.principal.display_name || 'Unknown'}</p>
                          <p className="text-xs text-gray-400 truncate">{p.principal.email}</p>
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          className="text-danger-600 border-danger-200 hover:bg-danger-50"
                          disabled={busyKey?.startsWith(`${editingGroup.assistant.id}:${p.principal.id}`)}
                          onClick={() => removePrincipal(editingGroup, p)}
                        >
                          Remove
                        </Button>
                      </div>
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1.5">
                        {CAPS.map((c) => (
                          <label key={c.key} className="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={!!p[c.key]}
                              disabled={busyKey?.startsWith(`${editingGroup.assistant.id}:${p.principal.id}`)}
                              onChange={(e) => toggleCap(editingGroup, p, c.key, e.target.checked)}
                              className="rounded border-gray-300"
                            />
                            {c.label}
                          </label>
                        ))}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}
        </div>
      )}

      {/* ---- Records ---- */}
      {loading ? (
        <div className="h-10 bg-gray-50 animate-pulse rounded-lg" />
      ) : groups.length === 0 ? (
        <p className="text-sm text-gray-400 italic">No assistants assigned yet.</p>
      ) : (
        <ul className="space-y-3">
          {groups.map((g) => (
            <li key={g.assistant.id} className="p-3 rounded-lg border border-gray-200">
              <div className="flex items-center justify-between gap-3 mb-2">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-gray-900 truncate">{g.assistant.display_name || 'Unnamed'}</p>
                  <p className="text-xs text-gray-400 truncate">
                    {g.assistant.email} · acts for {g.principals.size} {g.principals.size === 1 ? 'person' : 'people'}
                  </p>
                </div>
                <Button variant="secondary" size="sm" onClick={() => setEditing(g.assistant)}>Manage</Button>
              </div>
              <ul className="space-y-1.5">
                {Array.from(g.principals.values()).map((p) => (
                  <li key={p.principal.id} className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-medium text-gray-800">{p.principal.display_name || p.principal.email}</span>
                    <span className="flex flex-wrap gap-1">
                      {chipsFor(p).map((chip) => (
                        <span key={chip} className="px-1.5 py-0.5 rounded bg-gray-100 text-[11px] text-gray-600">{chip}</span>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
