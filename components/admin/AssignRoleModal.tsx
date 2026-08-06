import { useCallback, useEffect, useMemo, useState } from 'react';
import { Modal, Button } from '../ui';
import { useToast } from '../ui/ToastProvider';

interface RoleLite {
  id: string;
  name: string;
  slug: string;
  is_system?: boolean;
}

interface Permission {
  id: string;
  code: string;
  name: string;
  description: string | null;
  category: string;
}

interface AppUser {
  id: string;
  display_name: string | null;
  email: string;
  job_title?: string | null;
}


interface AssignRoleModalProps {
  isOpen: boolean;
  onClose: () => void;
  roles: RoleLite[];
  permissions?: Permission[];
  /** Preselect a user (e.g. when opened from the Users list). */
  initialUserId?: string;
  assignRole: (p: { user_id: string; role_id: string }) => Promise<any>;
  revokeRole: (p: { user_id: string; role_id: string }) => Promise<any>;
}

const titleCase = (s: string) =>
  s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

export default function AssignRoleModal({ isOpen, onClose, roles, permissions = [], initialUserId, assignRole, revokeRole }: AssignRoleModalProps) {
  const { addToast } = useToast();
  const [users, setUsers] = useState<AppUser[]>([]);
  const [search, setSearch] = useState('');
  const [selectedUserId, setSelectedUserId] = useState('');
  const [userRoles, setUserRoles] = useState<RoleLite[]>([]);
  const [roleToAdd, setRoleToAdd] = useState('');
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [loadingRoles, setLoadingRoles] = useState(false);
  const [busy, setBusy] = useState(false);

  // Per-user permission overrides: code → 'grant' | 'deny' (absent = inherit)
  const [overrides, setOverrides] = useState<Map<string, boolean>>(new Map());
  const [showOverrides, setShowOverrides] = useState(false);
  const [loadingOverrides, setLoadingOverrides] = useState(false);
  const [savingOverrides, setSavingOverrides] = useState(false);
  const [rolePermCodes, setRolePermCodes] = useState<Set<string>>(new Set());

  // Data-access scope: how much of the org's data this user can see.
  const [scopeLevel, setScopeLevel] = useState<string>('business_unit');
  const [scopeBUNames, setScopeBUNames] = useState<Set<string>>(new Set());
  const [businessUnits, setBusinessUnits] = useState<Array<{ id: string; name: string }>>([]);
  const [buSearch, setBuSearch] = useState('');
  const [showScope, setShowScope] = useState(false);
  const [loadingScope, setLoadingScope] = useState(false);
  const [savingScope, setSavingScope] = useState(false);

  // Load users + business units when the modal opens
  useEffect(() => {
    if (!isOpen) return;
    setSelectedUserId(initialUserId || '');
    setUserRoles([]);
    setSearch('');
    setOverrides(new Map());
    setShowOverrides(false);
    setShowScope(false);
    setBuSearch('');
    setLoadingUsers(true);
    fetch('/api/users')
      .then((r) => r.json())
      .then((d) => setUsers(d.users || []))
      .catch(() => addToast({ type: 'error', message: 'Failed to load users' }))
      .finally(() => setLoadingUsers(false));
    // Full business-unit list (no exclusions) for the custom-scope picker.
    fetch('/api/hrims/business-units')
      .then((r) => r.json())
      .then((d) => setBusinessUnits(
        (d.businessUnits || [])
          .map((b: any) => ({ id: b.id, name: b.name }))
          .filter((b: any) => b.name)
          .sort((a: any, b: any) => a.name.localeCompare(b.name))
      ))
      .catch(() => {/* non-fatal: custom scope just won't have suggestions */});
  }, [isOpen, initialUserId, addToast]);

  const loadUserRoles = useCallback((userId: string) => {
    if (!userId) { setUserRoles([]); setRolePermCodes(new Set()); return; }
    setLoadingRoles(true);
    fetch(`/api/rbac/assign?user_id=${userId}`)
      .then((r) => r.json())
      .then((d) => {
        setUserRoles(d.roles || []);
        // Codes granted via roles — shown as the "inherited" baseline in the override editor
        const codes = new Set<string>();
        for (const role of d.roles || []) {
          for (const p of role.permissions || []) codes.add(p.code);
        }
        setRolePermCodes(codes);
      })
      .catch(() => addToast({ type: 'error', message: 'Failed to load user roles' }))
      .finally(() => setLoadingRoles(false));
  }, [addToast]);

  const loadUserOverrides = useCallback((userId: string) => {
    if (!userId) return;
    setLoadingOverrides(true);
    fetch(`/api/rbac/overrides?user_id=${userId}`)
      .then((r) => r.json())
      .then((d) => {
        const m = new Map<string, boolean>();
        for (const o of d.overrides || []) m.set(o.code, o.granted);
        setOverrides(m);
      })
      .catch(() => addToast({ type: 'error', message: 'Failed to load permission overrides' }))
      .finally(() => setLoadingOverrides(false));
  }, [addToast]);

  const loadUserScope = useCallback((userId: string) => {
    if (!userId) { setScopeLevel('business_unit'); setScopeBUNames(new Set()); return; }
    setLoadingScope(true);
    fetch(`/api/rbac/scope?user_id=${userId}`)
      .then((r) => r.json())
      .then((d) => {
        setScopeLevel(d?.setting?.scope_level || 'business_unit');
        setScopeBUNames(new Set<string>(d?.setting?.business_unit_names || []));
      })
      .catch(() => addToast({ type: 'error', message: 'Failed to load data-access scope' }))
      .finally(() => setLoadingScope(false));
  }, [addToast]);

  useEffect(() => {
    loadUserRoles(selectedUserId);
    loadUserOverrides(selectedUserId);
    loadUserScope(selectedUserId);
  }, [selectedUserId, loadUserRoles, loadUserOverrides, loadUserScope]);

  const filteredUsers = useMemo(() => {
    const q = search.toLowerCase();
    return users.filter((u) =>
      (u.display_name || '').toLowerCase().includes(q) || u.email.toLowerCase().includes(q)
    );
  }, [users, search]);

  const assignableRoles = useMemo(
    () => roles.filter((r) => !userRoles.some((ur) => ur.id === r.id)),
    [roles, userRoles]
  );

  // When opened for a specific user (from the Users list or the Access & Rights
  // table) the modal is locked to that person — no user-search picker, just
  // their details with their current roles and access to edit.
  const isLocked = !!initialUserId;
  const selectedUser = useMemo(
    () => users.find((u) => u.id === selectedUserId),
    [users, selectedUserId]
  );

  const groupedPermissions = useMemo(() => {
    const g: Record<string, Permission[]> = {};
    for (const p of permissions) (g[p.category] ||= []).push(p);
    return g;
  }, [permissions]);

  const overrideCount = overrides.size;

  const handleAssign = async () => {
    if (!selectedUserId || !roleToAdd) return;
    setBusy(true);
    try {
      await assignRole({ user_id: selectedUserId, role_id: roleToAdd });
      addToast({ type: 'success', message: 'Role assigned' });
      setRoleToAdd('');
      loadUserRoles(selectedUserId);
    } catch (err: any) {
      addToast({ type: 'error', message: err.message || 'Failed to assign role' });
    } finally {
      setBusy(false);
    }
  };

  const handleRevoke = async (roleId: string) => {
    setBusy(true);
    try {
      await revokeRole({ user_id: selectedUserId, role_id: roleId });
      addToast({ type: 'success', message: 'Role revoked' });
      loadUserRoles(selectedUserId);
    } catch (err: any) {
      addToast({ type: 'error', message: err.message || 'Failed to revoke role' });
    } finally {
      setBusy(false);
    }
  };

  const handleSaveOverrides = async () => {
    if (!selectedUserId) return;
    setSavingOverrides(true);
    try {
      const payload = Array.from(overrides.entries()).map(([code, granted]) => ({ code, granted }));
      const res = await fetch('/api/rbac/overrides', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: selectedUserId, overrides: payload }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Failed to save overrides');
      addToast({ type: 'success', message: 'Permission overrides saved' });
    } catch (err: any) {
      addToast({ type: 'error', message: err.message || 'Failed to save overrides' });
    } finally {
      setSavingOverrides(false);
    }
  };

  const setOverride = (code: string, value: 'inherit' | 'grant' | 'deny') => {
    setOverrides((prev) => {
      const next = new Map(prev);
      if (value === 'inherit') next.delete(code);
      else next.set(code, value === 'grant');
      return next;
    });
  };

  const toggleScopeBU = (name: string) => {
    setScopeBUNames((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  };

  const handleSaveScope = async () => {
    if (!selectedUserId) return;
    if (scopeLevel === 'custom' && scopeBUNames.size === 0) {
      addToast({ type: 'error', message: 'Select at least one business unit for a custom scope.' });
      return;
    }
    setSavingScope(true);
    try {
      const res = await fetch('/api/rbac/scope', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: selectedUserId,
          scope_level: scopeLevel,
          business_unit_names: scopeLevel === 'custom' ? Array.from(scopeBUNames) : [],
        }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Failed to save data-access scope');
      addToast({ type: 'success', message: 'Data-access scope saved' });
    } catch (err: any) {
      addToast({ type: 'error', message: err.message || 'Failed to save data-access scope' });
    } finally {
      setSavingScope(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="User Access Manager" size="lg">
      <div className="space-y-4 max-h-[70vh] overflow-y-auto pr-1">
        {/* User — locked identity header when opened for a specific person,
            otherwise a searchable picker. */}
        {isLocked ? (
          <div className="flex items-center gap-3 rounded-xl border border-gray-200 bg-gray-50 px-4 py-3">
            <div className="w-11 h-11 rounded-full bg-brand-100 text-brand-700 flex items-center justify-center font-semibold text-sm flex-shrink-0">
              {(selectedUser?.display_name || selectedUser?.email || '?').slice(0, 2).toUpperCase()}
            </div>
            <div className="min-w-0">
              <div className="font-semibold text-gray-900 truncate">
                {selectedUser?.display_name || (loadingUsers ? 'Loading…' : 'Unnamed user')}
              </div>
              <div className="text-xs text-gray-500 truncate">
                {selectedUser?.email}
                {selectedUser?.job_title ? ` · ${selectedUser.job_title}` : ''}
              </div>
            </div>
          </div>
        ) : (
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">User</label>
            <input
              type="text"
              placeholder="Search users by name or email…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full px-4 py-2 mb-2 rounded-xl border border-gray-300 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent"
            />
            <div className="max-h-40 overflow-y-auto border border-gray-200 rounded-xl divide-y divide-gray-100">
              {loadingUsers ? (
                <div className="p-3 text-sm text-gray-400">Loading users…</div>
              ) : filteredUsers.length === 0 ? (
                <div className="p-3 text-sm text-gray-400">No users found</div>
              ) : (
                filteredUsers.map((u) => (
                  <button
                    key={u.id}
                    type="button"
                    onClick={() => setSelectedUserId(u.id)}
                    className={`w-full text-left px-3 py-2 text-sm hover:bg-gray-50 transition-colors ${
                      selectedUserId === u.id ? 'bg-brand-50' : ''
                    }`}
                  >
                    <div className="font-medium text-gray-800">{u.display_name || u.email}</div>
                    <div className="text-xs text-gray-400">{u.email}</div>
                  </button>
                ))
              )}
            </div>
          </div>
        )}

        {selectedUserId && (
          <>
            {/* ---- Roles ---- */}
            <div className="border-t border-gray-100 pt-4">
              <h4 className="text-sm font-semibold text-gray-800 mb-2">Roles</h4>
              {loadingRoles ? (
                <p className="text-sm text-gray-400">Loading…</p>
              ) : userRoles.length === 0 ? (
                <p className="text-sm text-gray-400 mb-3">No roles assigned yet.</p>
              ) : (
                <div className="flex flex-wrap gap-2 mb-3">
                  {userRoles.map((r) => (
                    <span key={r.id} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-gray-100 text-sm text-gray-700">
                      {r.name}
                      <button
                        type="button"
                        onClick={() => handleRevoke(r.id)}
                        disabled={busy}
                        className="text-gray-400 hover:text-red-600"
                        title="Revoke"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </span>
                  ))}
                </div>
              )}

              <div className="flex items-end gap-2">
                <div className="flex-1">
                  <label className="block text-sm font-medium text-gray-700 mb-1">Add a role</label>
                  <select
                    value={roleToAdd}
                    onChange={(e) => setRoleToAdd(e.target.value)}
                    className="w-full px-4 py-2 rounded-xl border border-gray-300 bg-white focus:outline-none focus:ring-2 focus:ring-brand-500"
                  >
                    <option value="">Select a role…</option>
                    {assignableRoles.map((r) => (
                      <option key={r.id} value={r.id}>{r.name}</option>
                    ))}
                  </select>
                </div>
                <Button variant="primary" onClick={handleAssign} disabled={!roleToAdd || busy}>Assign</Button>
              </div>
            </div>


            {/* ---- Data-access scope ---- */}
            <div className="border-t border-gray-100 pt-4">
              <button
                type="button"
                onClick={() => setShowScope(!showScope)}
                className="flex w-full items-center justify-between"
              >
                <span className="text-sm font-semibold text-gray-800">
                  Data access scope
                  <span className="ml-2 px-2 py-0.5 rounded-full text-xs font-medium bg-brand-50 text-brand-700">
                    {scopeLevel === 'custom'
                      ? `${scopeBUNames.size} unit${scopeBUNames.size === 1 ? '' : 's'}`
                      : titleCase(scopeLevel)}
                  </span>
                </span>
                <svg
                  className={`w-4 h-4 text-gray-400 transition-transform ${showScope ? 'rotate-180' : ''}`}
                  fill="none" stroke="currentColor" viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
              <p className="text-xs text-gray-500 mt-1">
                Controls how much data (CAPEX tracker, reports, etc.) this user can see — independent of what they can do.
                Choose <strong>Specific business units</strong> to restrict them to a chosen set.
              </p>

              {showScope && (
                loadingScope ? (
                  <p className="text-sm text-gray-400 mt-3">Loading…</p>
                ) : (
                  <div className="mt-3 space-y-3">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Scope level</label>
                      <select
                        value={scopeLevel}
                        onChange={(e) => setScopeLevel(e.target.value)}
                        className="w-full px-4 py-2 rounded-xl border border-gray-300 bg-white focus:outline-none focus:ring-2 focus:ring-brand-500"
                      >
                        <option value="own">Own records only</option>
                        <option value="department">Their department</option>
                        <option value="business_unit">Their home business unit (default)</option>
                        <option value="custom">Specific business units…</option>
                        <option value="organization">Entire organization</option>
                      </select>
                    </div>

                    {scopeLevel === 'custom' && (
                      <div className="border border-gray-200 rounded-xl p-3">
                        <div className="flex items-center justify-between mb-2">
                          <h5 className="text-sm font-medium text-gray-800">Business units this user can see</h5>
                          <span className="text-xs text-gray-400">{scopeBUNames.size} selected</span>
                        </div>
                        <input
                          type="text"
                          placeholder="Filter business units…"
                          value={buSearch}
                          onChange={(e) => setBuSearch(e.target.value)}
                          className="w-full px-3 py-1.5 mb-2 text-sm rounded-lg border border-gray-300 focus:outline-none focus:ring-2 focus:ring-brand-500"
                        />
                        <div className="max-h-48 overflow-y-auto space-y-1">
                          {businessUnits.length === 0 ? (
                            <p className="text-sm text-gray-400 py-2">No business units available.</p>
                          ) : (
                            businessUnits
                              .filter((b) => !buSearch || b.name.toLowerCase().includes(buSearch.toLowerCase()))
                              .map((b) => (
                                <label key={b.id} className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-gray-50 cursor-pointer">
                                  <input
                                    type="checkbox"
                                    className="w-4 h-4 rounded border-gray-300 text-brand-600 focus:ring-brand-500"
                                    checked={scopeBUNames.has(b.name)}
                                    onChange={() => toggleScopeBU(b.name)}
                                  />
                                  <span className="text-sm text-gray-700">{b.name}</span>
                                </label>
                              ))
                          )}
                        </div>
                        {/* Any names already saved that aren't in the current BU list (kept so they aren't lost). */}
                        {Array.from(scopeBUNames).filter((n) => !businessUnits.some((b) => b.name === n)).map((n) => (
                          <label key={n} className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-gray-50 cursor-pointer">
                            <input
                              type="checkbox"
                              className="w-4 h-4 rounded border-gray-300 text-brand-600 focus:ring-brand-500"
                              checked
                              onChange={() => toggleScopeBU(n)}
                            />
                            <span className="text-sm text-gray-700">{n} <span className="text-xs text-gray-400">(saved)</span></span>
                          </label>
                        ))}
                      </div>
                    )}

                    <div className="flex justify-end">
                      <Button variant="primary" onClick={handleSaveScope} disabled={savingScope}>
                        {savingScope ? 'Saving…' : 'Save data scope'}
                      </Button>
                    </div>
                  </div>
                )
              )}
            </div>

            {/* ---- Per-user permission overrides ---- */}
            <div className="border-t border-gray-100 pt-4">
              <button
                type="button"
                onClick={() => setShowOverrides(!showOverrides)}
                className="flex w-full items-center justify-between"
              >
                <span className="text-sm font-semibold text-gray-800">
                  Permission overrides
                  {overrideCount > 0 && (
                    <span className="ml-2 px-2 py-0.5 rounded-full text-xs font-medium bg-brand-50 text-brand-700">
                      {overrideCount} active
                    </span>
                  )}
                </span>
                <svg
                  className={`w-4 h-4 text-gray-400 transition-transform ${showOverrides ? 'rotate-180' : ''}`}
                  fill="none" stroke="currentColor" viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
              <p className="text-xs text-gray-500 mt-1">
                Fine-tune this user&apos;s permissions on top of their roles: <strong>Grant</strong> adds a permission
                their roles don&apos;t have; <strong>Deny</strong> removes one their roles grant.
              </p>

              {showOverrides && (
                loadingOverrides ? (
                  <p className="text-sm text-gray-400 mt-3">Loading…</p>
                ) : (
                  <div className="mt-3 space-y-3">
                    {Object.entries(groupedPermissions).map(([cat, perms]) => (
                      <div key={cat} className="border border-gray-200 rounded-xl p-3">
                        <h5 className="text-sm font-medium text-gray-800 mb-2">{titleCase(cat)}</h5>
                        <div className="space-y-1.5">
                          {perms.map((p) => {
                            const fromRole = rolePermCodes.has(p.code);
                            const ov = overrides.get(p.code);
                            const value: 'inherit' | 'grant' | 'deny' =
                              ov === undefined ? 'inherit' : ov ? 'grant' : 'deny';
                            return (
                              <div key={p.id} className="flex items-center justify-between gap-2">
                                <span className="text-sm text-gray-700 min-w-0 truncate" title={p.description || p.code}>
                                  {p.name}
                                  <span className={`ml-2 text-[11px] ${fromRole ? 'text-emerald-600' : 'text-gray-400'}`}>
                                    {fromRole ? 'via role' : 'not granted'}
                                  </span>
                                </span>
                                <select
                                  value={value}
                                  onChange={(e) => setOverride(p.code, e.target.value as any)}
                                  className={`rounded-lg border px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-brand-500 ${
                                    value === 'grant'
                                      ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
                                      : value === 'deny'
                                        ? 'border-rose-300 bg-rose-50 text-rose-700'
                                        : 'border-gray-200 bg-white text-gray-600'
                                  }`}
                                >
                                  <option value="inherit">Inherit</option>
                                  <option value="grant">Grant</option>
                                  <option value="deny">Deny</option>
                                </select>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                    <div className="flex justify-end">
                      <Button variant="primary" onClick={handleSaveOverrides} disabled={savingOverrides}>
                        {savingOverrides ? 'Saving…' : 'Save overrides'}
                      </Button>
                    </div>
                  </div>
                )
              )}
            </div>
          </>
        )}
      </div>

      <div className="flex items-center justify-end mt-4 pt-4 border-t border-gray-100">
        <Button variant="secondary" onClick={onClose}>Done</Button>
      </div>
    </Modal>
  );
}
