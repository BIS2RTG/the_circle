import { useState, useEffect } from 'react';
import { Card } from '../../ui';
import { SectionHeading, AccessIcon } from './shared';
import Loader from '../../Loader';

interface AccessConfigProps {
  /** Called when a user row is clicked, so the parent can open the access manager. */
  onSelectUser?: (userId: string) => void;
}

// Human-readable "at a glance" label for a user's data-access scope.
function scopeLabel(u: any): { text: string; cls: string } {
  const level = u.access_scope_level;
  const n = u.access_scope_bu_count || 0;
  switch (level) {
    case 'organization': return { text: 'Whole organization', cls: 'bg-purple-50 text-purple-700 border-purple-200' };
    case 'custom':       return { text: `${n} business unit${n === 1 ? '' : 's'}`, cls: 'bg-sky-50 text-sky-700 border-sky-200' };
    case 'department':   return { text: 'Their department', cls: 'bg-amber-50 text-amber-700 border-amber-200' };
    case 'own':          return { text: 'Own records only', cls: 'bg-gray-100 text-gray-600 border-gray-200' };
    case 'business_unit':return { text: 'Home business unit', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' };
    default:             return { text: 'Home BU (default)', cls: 'bg-gray-50 text-gray-500 border-gray-200' };
  }
}

export function AccessConfig({ onSelectUser }: AccessConfigProps = {}) {
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [accessUsers, setAccessUsers] = useState<any[]>([]);
  const [accessLoading, setAccessLoading] = useState(true);

  useEffect(() => {
    async function loadData() {
      try {
        const res = await fetch('/api/admin/users');
        if (res.ok) {
          const data = await res.json();
          setAccessUsers(data.users || []);
        }
      } catch (err) {
        console.error('Error loading access data:', err);
      } finally {
        setAccessLoading(false);
      }
    }
    loadData();
  }, []);

  // Roles present across the loaded users — powers the role filter dropdown.
  const availableRoles = (() => {
    const byId = new Map<string, { id: string; name: string }>();
    for (const u of accessUsers) {
      for (const r of u.roles || []) {
        if (r?.id && !byId.has(r.id)) byId.set(r.id, { id: r.id, name: r.name });
      }
    }
    return Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name));
  })();

  const filteredUsers = accessUsers.filter((u: any) => {
    if (roleFilter && !(u.roles || []).some((r: any) => r.id === roleFilter)) return false;
    if (!search) return true;
    const s = search.toLowerCase();
    return (u.display_name || '').toLowerCase().includes(s) || (u.email || '').toLowerCase().includes(s);
  });

  return (
    <div className="space-y-6 animate-fade-in">
      <SectionHeading title="Access & Rights Assignment" subtitle="Click a user to manage their roles, data-access scope and individual permission overrides." />

      <Card className="!p-0 overflow-hidden border border-border">
        <div className="p-4 bg-neutral-50 border-b border-border flex items-center gap-4">
          <div className="w-10 h-10 flex items-center justify-center text-neutral-700">
            <AccessIcon />
          </div>
          <div>
            <h3 className="font-semibold text-text-primary">Restricted Assignment Policy</h3>
            <p className="text-sm text-text-secondary">
              For security, roles equal to or higher than <strong>Super Admin</strong> cannot be assigned from this interface.
            </p>
          </div>
        </div>

        <div className="p-4 border-b border-border flex flex-col gap-3 sm:flex-row sm:items-center">
          <input
            type="text"
            placeholder="Search users..."
            className="w-full max-w-md px-4 py-2 border border-border rounded-xl focus:ring-2 focus:ring-primary-100 focus:border-primary-300 outline-none"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select
            value={roleFilter}
            onChange={(e) => setRoleFilter(e.target.value)}
            className="w-full sm:w-auto px-4 py-2 border border-border rounded-xl bg-white focus:ring-2 focus:ring-primary-100 focus:border-primary-300 outline-none"
          >
            <option value="">All roles</option>
            {availableRoles.map((r) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </select>
          {(roleFilter || search) && (
            <button
              type="button"
              onClick={() => { setRoleFilter(''); setSearch(''); }}
              className="text-sm font-medium text-primary-600 hover:text-primary-700"
            >
              Clear
            </button>
          )}
        </div>

        {accessLoading ? (
          <Loader fullScreen={false} size={120} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm whitespace-nowrap">
              <thead className="bg-gray-50 text-gray-600">
                <tr>
                  <th className="px-6 py-3 font-semibold">User</th>
                  <th className="px-6 py-3 font-semibold">Assigned Roles</th>
                  <th className="px-6 py-3 font-semibold">Data Access</th>
                  <th className="px-6 py-3 font-semibold">Status</th>
                  {onSelectUser && <th className="px-6 py-3 font-semibold text-right">Manage</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filteredUsers.slice(0, 25).map((u: any) => (
                  <tr
                    key={u.id}
                    onClick={onSelectUser ? () => onSelectUser(u.id) : undefined}
                    className={`transition-colors ${onSelectUser ? 'cursor-pointer hover:bg-primary-50/60' : 'hover:bg-gray-50'}`}
                  >
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full bg-neutral-100 text-neutral-700 flex items-center justify-center font-bold text-xs">
                          {(u.display_name || u.email || '?').charAt(0).toUpperCase()}
                        </div>
                        <div>
                          <div className="font-medium text-gray-900">{u.display_name || 'Unnamed'}</div>
                          <div className="text-xs text-gray-500">{u.email}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex gap-1 flex-wrap">
                        {(u.roles || []).length > 0 ? u.roles.map((r: any) => (
                          <span key={r.id} className="px-2 py-1 bg-gray-100 text-gray-700 rounded-md text-xs border border-gray-200">{r.name}</span>
                        )) : (
                          <span className="text-xs text-gray-400 italic">No roles</span>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      {(() => { const s = scopeLabel(u); return (
                        <span className={`px-2 py-1 rounded-full text-xs font-medium border ${s.cls}`}>{s.text}</span>
                      ); })()}
                    </td>
                    <td className="px-6 py-4">
                      <span className={`px-2 py-1 rounded-full text-xs font-medium ${u.is_active !== false ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'}`}>
                        {u.is_active !== false ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    {onSelectUser && (
                      <td className="px-6 py-4 text-right">
                        <span className="inline-flex items-center gap-1 text-xs font-medium text-primary-600">
                          Manage access
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5l7 7-7 7" />
                          </svg>
                        </span>
                      </td>
                    )}
                  </tr>
                ))}
                {filteredUsers.length === 0 && (
                  <tr><td colSpan={onSelectUser ? 5 : 4} className="px-6 py-8 text-center text-gray-400">No users found</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
