import React, { useEffect, useRef, useState } from 'react';
import { useAssistantPrincipals } from '../../hooks/useAssistantPrincipals';

export interface OnBehalfOf {
  /** app_users id. Absent for an external beneficiary. */
  userId?: string;
  name?: string;
  positionTitle?: string;
  email?: string;
  /** True when this person is not part of the organization (no account). */
  external?: boolean;
  company?: string;
}

interface OnBehalfOfFieldProps {
  value: OnBehalfOf | null;
  onChange: (value: OnBehalfOf | null) => void;
  disabled?: boolean;
}

interface DirectoryUser {
  id: string;
  display_name: string;
  email: string;
  job_title?: string;
}

type Mode = 'self' | 'employee' | 'external';

/**
 * "Filing on behalf of" selector.
 *
 * Two rights feed it, and they ADD UP rather than replace one another:
 *
 *   - An assistant picks from the specific people a systems admin assigned
 *     them to support — a plain dropdown.
 *   - An HR admin (`requests.file_on_behalf_any`) additionally searches the
 *     whole directory, and can name a guest with no account here at all.
 *
 * Someone holding both sees their assigned principals as quick picks inside
 * the employee search, so gaining the HR right never costs them the shortcut
 * to their own boss.
 *
 * It renders nothing for everyone else. Whatever is chosen is re-verified
 * server-side on submit (lib/onBehalf.ts) — this field is convenience, not
 * the control.
 */
export function OnBehalfOfField({ value, onChange, disabled }: OnBehalfOfFieldProps) {
  const { principals, canFileForAnyone, loading } = useAssistantPrincipals();

  const [mode, setMode] = useState<Mode>(() =>
    value?.external ? 'external' : value?.userId ? 'employee' : 'self'
  );
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<DirectoryUser[]>([]);
  const [searching, setSearching] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);

  // Directory search, debounced. Only ever runs for HR admins in employee mode.
  useEffect(() => {
    if (!canFileForAnyone || mode !== 'employee') return;
    const term = search.trim();
    if (term.length < 2) {
      setResults([]);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const handle = setTimeout(async () => {
      try {
        const resp = await fetch(`/api/users/search?q=${encodeURIComponent(term)}`);
        const data = resp.ok ? await resp.json() : { users: [] };
        if (!cancelled) setResults(data.users || []);
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [search, mode, canFileForAnyone]);

  // Close the results list on an outside click.
  useEffect(() => {
    if (!showResults) return;
    const onDocClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setShowResults(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [showResults]);

  // Nothing to offer — hide entirely.
  if (loading || (principals.length === 0 && !canFileForAnyone)) return null;

  const switchMode = (next: Mode) => {
    setMode(next);
    setSearch('');
    setResults([]);
    setShowResults(false);
    // Each mode owns a different shape, so never carry a stale value across.
    onChange(null);
  };

  const selectPrincipal = (userId: string) => {
    if (!userId) return onChange(null);
    const principal = principals.find((p) => p.userId === userId);
    if (!principal) return onChange(null);
    onChange({
      userId: principal.userId,
      name: principal.name,
      positionTitle: principal.positionTitle,
      email: principal.email,
    });
  };

  const selectDirectoryUser = (u: DirectoryUser) => {
    onChange({
      userId: u.id,
      name: u.display_name || u.email,
      positionTitle: u.job_title || undefined,
      email: u.email,
    });
    setSearch('');
    setResults([]);
    setShowResults(false);
  };

  const updateExternal = (patch: Partial<OnBehalfOf>) => {
    const next: OnBehalfOf = {
      external: true,
      name: value?.name || '',
      email: value?.email || '',
      company: value?.company || '',
      ...patch,
    };
    // An external beneficiary with no name isn't one yet — keep it null so the
    // request files as "myself" rather than half-populated.
    onChange(next.name && next.name.trim() ? next : null);
  };

  const tab = (m: Mode, label: string) => (
    <button
      key={m}
      type="button"
      disabled={disabled}
      onClick={() => switchMode(m)}
      className={`px-3 py-1.5 text-sm font-medium rounded-lg transition-colors disabled:opacity-60 ${
        mode === m
          ? 'bg-primary-600 text-white'
          : 'bg-white text-gray-600 border border-gray-300 hover:bg-gray-50'
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="space-y-2" ref={boxRef}>
      <div>
        <h3 className="text-sm font-semibold text-text-primary">Filing on behalf of</h3>
        <p className="text-xs text-text-secondary mt-0.5">
          {canFileForAnyone
            ? (principals.length > 0
                ? 'You may file this request for someone you assist, for any other employee, or for a guest outside the organization. Leave as “Myself” to file it for yourself.'
                : 'You may file this request for any employee, or for a guest outside the organization. Leave as “Myself” to file it for yourself.')
            : 'You may file this request on behalf of someone you assist. Leave as “Myself” to file it for yourself.'}
        </p>
      </div>

      {canFileForAnyone ? (
        <>
          <div className="flex flex-wrap gap-2">
            {tab('self', 'Myself')}
            {tab('employee', 'An employee')}
            {tab('external', 'Someone outside the organization')}
          </div>

          {mode === 'employee' && (
            <div className="relative">
              {value?.userId ? (
                <div className="flex items-center gap-3 p-3 rounded-lg bg-primary-50 border border-primary-200">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{value.name}</p>
                    <p className="text-xs text-gray-500 truncate">
                      {value.email}
                      {value.positionTitle ? ` · ${value.positionTitle}` : ''}
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => onChange(null)}
                    className="flex-shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-full border border-danger-100 bg-danger-50 text-danger-600 shadow-sm hover:bg-danger-500 hover:border-danger-500 hover:text-white focus:outline-none focus:ring-2 focus:ring-danger-500 focus:ring-offset-1 transition-all"
                    title="Clear selection"
                    aria-label="Clear selection"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              ) : (
                <>
                  {/* Being an HR admin ADDS the directory search; it must not
                      take away the principals an assistant was assigned. */}
                  {principals.length > 0 && (
                    <div className="mb-2">
                      <p className="text-xs font-medium text-gray-600 mb-1.5">People you assist</p>
                      <div className="flex flex-wrap gap-2">
                        {principals.map((p) => (
                          <button
                            key={p.userId}
                            type="button"
                            disabled={disabled}
                            onClick={() => selectPrincipal(p.userId)}
                            className="px-3 py-1.5 text-sm rounded-lg border border-gray-300 bg-white text-gray-700 hover:bg-primary-50 hover:border-primary-300 hover:text-primary-700 transition-colors disabled:opacity-60"
                          >
                            {p.name}
                            {p.positionTitle ? <span className="text-gray-400"> · {p.positionTitle}</span> : null}
                          </button>
                        ))}
                      </div>
                      <p className="text-xs text-gray-400 mt-1.5">Or search for anyone else below.</p>
                    </div>
                  )}
                  <input
                    type="text"
                    autoComplete="off"
                    disabled={disabled}
                    value={search}
                    onChange={(e) => {
                      setSearch(e.target.value);
                      setShowResults(true);
                    }}
                    onFocus={() => setShowResults(true)}
                    placeholder="Search employees by name or email…"
                    className="w-full px-3 py-2 rounded-lg border border-gray-300 focus:ring-1 focus:ring-primary-500 outline-none text-sm bg-white disabled:opacity-60"
                  />
                  {showResults && search.trim().length >= 2 && (
                    <div className="absolute z-30 left-0 right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-56 overflow-y-auto">
                      {searching && results.length === 0 ? (
                        <p className="px-3 py-2 text-sm text-gray-500">Searching…</p>
                      ) : results.length === 0 ? (
                        <p className="px-3 py-2 text-sm text-gray-500">No matching employee.</p>
                      ) : (
                        results.map((u) => (
                          <button
                            key={u.id}
                            type="button"
                            onClick={() => selectDirectoryUser(u)}
                            className="w-full px-3 py-2 text-left hover:bg-primary-50 transition-colors border-b border-gray-100 last:border-b-0"
                          >
                            <p className="text-sm font-medium text-gray-900 truncate">{u.display_name || u.email}</p>
                            <p className="text-xs text-gray-500 truncate">
                              {u.email}
                              {u.job_title ? ` · ${u.job_title}` : ''}
                            </p>
                          </button>
                        ))
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {mode === 'external' && (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="sm:col-span-3">
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  Full name <span className="text-danger-500">*</span>
                </label>
                <input
                  type="text"
                  disabled={disabled}
                  value={value?.name || ''}
                  onChange={(e) => updateExternal({ name: e.target.value })}
                  placeholder="e.g. Dr Farai Chikomo"
                  className="w-full px-3 py-2 rounded-lg border border-gray-300 focus:ring-1 focus:ring-primary-500 outline-none text-sm bg-white disabled:opacity-60"
                />
              </div>
              <div className="sm:col-span-2">
                <label className="block text-xs font-medium text-gray-600 mb-1">Email (optional)</label>
                <input
                  type="email"
                  disabled={disabled}
                  value={value?.email || ''}
                  onChange={(e) => updateExternal({ email: e.target.value })}
                  placeholder="name@example.com"
                  className="w-full px-3 py-2 rounded-lg border border-gray-300 focus:ring-1 focus:ring-primary-500 outline-none text-sm bg-white disabled:opacity-60"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Organization (optional)</label>
                <input
                  type="text"
                  disabled={disabled}
                  value={value?.company || ''}
                  onChange={(e) => updateExternal({ company: e.target.value })}
                  placeholder="e.g. Ministry of Tourism"
                  className="w-full px-3 py-2 rounded-lg border border-gray-300 focus:ring-1 focus:ring-primary-500 outline-none text-sm bg-white disabled:opacity-60"
                />
              </div>
            </div>
          )}
        </>
      ) : (
        <select
          value={value?.userId || ''}
          disabled={disabled}
          onChange={(e) => selectPrincipal(e.target.value)}
          className="w-full px-3 py-2 rounded-lg border border-gray-300 focus:ring-1 focus:ring-primary-500 outline-none text-sm bg-white disabled:opacity-60"
        >
          <option value="">Myself</option>
          {principals.map((principal) => (
            <option key={principal.userId} value={principal.userId}>
              {principal.name}
              {principal.positionTitle ? ` — ${principal.positionTitle}` : ''}
            </option>
          ))}
        </select>
      )}

      {value?.userId && (
        <p className="text-xs text-primary-700 bg-primary-50 border border-primary-200 rounded-lg px-3 py-2">
          This request will be filed on behalf of <strong>{value.name}</strong>
          {value.positionTitle ? ` (${value.positionTitle})` : ''}. You remain the filer of record and
          will receive the approval updates; {value.name?.split(' ')[0] || 'they'} will be notified once it is
          fully approved. Approvers are resolved from <strong>their</strong> reporting line.
        </p>
      )}

      {value?.external && value.name && (
        <p className="text-xs text-primary-700 bg-primary-50 border border-primary-200 rounded-lg px-3 py-2">
          This request will be filed for <strong>{value.name}</strong>
          {value.company ? ` of ${value.company}` : ''}, who is outside the organization. You remain the
          filer of record and will receive all updates — they have no account here, so nothing is sent to
          them. Choose the approvers yourself; there is no reporting line to resolve.
        </p>
      )}
    </div>
  );
}
