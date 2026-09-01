import { useEffect, useMemo, useState } from 'react';
import Head from 'next/head';
import { AppLayout } from '../../components/layout';
import { Card, Button } from '../../components/ui';
import { useRBAC } from '../../contexts/RBACContext';
import { useToast } from '../../components/ui/ToastProvider';
import {
  UserCog, Plus, X, Search, CalendarClock, Paperclip, ImagePlus,
  ExternalLink, AlertTriangle, ShieldCheck, Loader2, Inbox,
} from 'lucide-react';

interface OrgUser {
  id: string;
  display_name: string;
  email: string;
  job_title?: string;
}

interface Delegation {
  id: string;
  reason: string;
  starts_at: string;
  ends_at: string;
  status: string;
  created_at: string;
  scope?: string;
  request_ids?: string[] | null;
  delegator: { id: string; display_name: string; email: string; job_title?: string } | null;
  delegate: { id: string; display_name: string; email: string; job_title?: string } | null;
  created_by_user: { id: string; display_name: string } | null;
  documents?: { name: string; download_url: string | null }[];
}

/** A request the delegation could cover, as returned by requests-search. */
interface CandidateRequest {
  requestId: string;
  title: string;
  description: string | null;
  referenceCode: string | null;
  requestType: string | null;
  amount: number | string | null;
  currency: string | null;
  requesterName: string | null;
  requesterTitle: string | null;
  createdAt: string;
  awaitingNow: boolean;
  delegateConflict: boolean;
}

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

const statusStyles: Record<string, string> = {
  active: 'bg-success-50 text-success-600 border-success-100',
  revoked: 'bg-neutral-100 text-neutral-500 border-neutral-200',
  expired: 'bg-amber-50 text-amber-700 border-amber-200',
};

// ---- User search combobox -------------------------------------------------
function UserSelect({
  users,
  value,
  onChange,
  placeholder,
  excludeId,
}: {
  users: OrgUser[];
  value: OrgUser | null;
  onChange: (u: OrgUser | null) => void;
  placeholder: string;
  excludeId?: string;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const filtered = users.filter((u) => {
    if (excludeId && u.id === excludeId) return false;
    const q = query.toLowerCase();
    return (
      u.display_name?.toLowerCase().includes(q) ||
      u.email?.toLowerCase().includes(q) ||
      u.job_title?.toLowerCase().includes(q)
    );
  });

  if (value) {
    return (
      <div className="flex items-center gap-3 bg-primary-50 border border-primary-200 p-2.5 rounded-xl">
        <div className="w-9 h-9 rounded-full bg-primary-100 flex items-center justify-center shrink-0 text-sm font-semibold text-primary-600">
          {value.display_name?.charAt(0)?.toUpperCase() || '?'}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-gray-900 truncate">{value.display_name}</p>
          <p className="text-xs text-gray-500 truncate">{value.job_title || value.email}</p>
        </div>
        <button onClick={() => onChange(null)} className="p-1.5 rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-500">
          <X className="w-4 h-4" />
        </button>
      </div>
    );
  }

  return (
    <div className="relative">
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
      <input
        type="text"
        className="w-full pl-9 pr-4 py-2.5 rounded-xl border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
        placeholder={placeholder}
        value={query}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
      />
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute z-20 w-full mt-1 bg-white border border-gray-200 rounded-xl shadow-lg max-h-52 overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="px-4 py-3 text-sm text-gray-500">No users found</div>
            ) : (
              filtered.slice(0, 12).map((u) => (
                <button
                  key={u.id}
                  type="button"
                  onClick={() => { onChange(u); setQuery(''); setOpen(false); }}
                  className="w-full px-4 py-2.5 text-left hover:bg-primary-50 flex items-center gap-3 border-b border-gray-100 last:border-0"
                >
                  <div className="w-8 h-8 rounded-full bg-primary-100 flex items-center justify-center shrink-0 text-sm font-semibold text-primary-600">
                    {u.display_name?.charAt(0)?.toUpperCase() || '?'}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{u.display_name}</p>
                    <p className="text-xs text-gray-500 truncate">{u.job_title || u.email}</p>
                  </div>
                </button>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ---- Request picker -------------------------------------------------------
/**
 * Searchable list of the delegator's live approvals. Search covers request id,
 * reference code, title, wording, type and requester, and every row can be
 * opened in a new tab so the admin can read the request before handing it over.
 */
function RequestPicker({
  delegatorId,
  delegatorName,
  delegateId,
  selected,
  onToggle,
}: {
  delegatorId: string;
  delegatorName: string;
  delegateId?: string;
  selected: Set<string>;
  onToggle: (id: string, row: CandidateRequest) => void;
}) {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [rows, setRows] = useState<CandidateRequest[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const params = new URLSearchParams({ delegatorId });
    if (delegateId) params.set('delegateId', delegateId);
    if (debounced) params.set('q', debounced);
    fetch(`/api/admin/delegations/requests-search?${params.toString()}`)
      .then((r) => (r.ok ? r.json() : { requests: [], total: 0 }))
      .then((d) => {
        if (cancelled) return;
        setRows(d.requests || []);
        setTotal(d.total || 0);
      })
      .catch(() => { if (!cancelled) { setRows([]); setTotal(0); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [delegatorId, delegateId, debounced]);

  return (
    <div className="rounded-xl border border-gray-200 overflow-hidden">
      <div className="relative border-b border-gray-200 bg-gray-50">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by request ID, reference, title, details or requester…"
          className="w-full pl-9 pr-9 py-2.5 bg-transparent text-sm focus:outline-none"
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery('')}
            className="absolute right-3 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-gray-200 text-gray-400"
            aria-label="Clear search"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      <div className="max-h-72 overflow-y-auto divide-y divide-gray-100">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-gray-500">
            <Loader2 className="w-4 h-4 animate-spin" /> Searching…
          </div>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-8 px-4 text-center">
            <Inbox className="w-6 h-6 text-gray-300" />
            <p className="text-sm text-gray-500">
              {debounced
                ? `No requests match “${debounced}”.`
                : `${delegatorName} has no approvals waiting.`}
            </p>
          </div>
        ) : (
          rows.map((r) => {
            const isSelected = selected.has(r.requestId);
            const blocked = r.delegateConflict;
            return (
              <div
                key={r.requestId}
                className={`flex items-start gap-3 p-3 ${blocked ? 'bg-amber-50/50' : isSelected ? 'bg-primary-50' : 'hover:bg-gray-50'}`}
              >
                <input
                  type="checkbox"
                  checked={isSelected}
                  disabled={blocked}
                  onChange={() => onToggle(r.requestId, r)}
                  className="mt-1 rounded border-gray-300 text-primary-600 focus:ring-primary-500 disabled:opacity-40"
                  aria-label={`Delegate ${r.title}`}
                />
                <button
                  type="button"
                  disabled={blocked}
                  onClick={() => onToggle(r.requestId, r)}
                  className="flex-1 min-w-0 text-left disabled:cursor-not-allowed"
                >
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-gray-900 line-clamp-1">{r.title}</span>
                    {r.awaitingNow && (
                      <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-primary-100 text-primary-700 shrink-0">
                        On their desk
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-gray-500 mt-0.5 truncate">
                    {[
                      r.referenceCode,
                      r.requestType,
                      r.requesterName ? `by ${r.requesterName}` : null,
                      r.amount != null ? `${r.currency || ''} ${r.amount}`.trim() : null,
                      fmtDate(r.createdAt),
                    ].filter(Boolean).join(' • ')}
                  </p>
                  <p className="text-[11px] text-gray-400 mt-0.5 font-mono truncate">{r.requestId}</p>
                  {blocked && (
                    <p className="flex items-start gap-1 text-[11px] text-amber-700 mt-1">
                      <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
                      The delegate is already an approver on this request — one person cannot sign it twice.
                    </p>
                  )}
                </button>
                <a
                  href={`/requests/${r.requestId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="shrink-0 p-1.5 rounded-lg text-gray-400 hover:text-primary-600 hover:bg-white"
                  title="Open request in a new tab"
                  aria-label={`Open ${r.title} in a new tab`}
                >
                  <ExternalLink className="w-4 h-4" />
                </a>
              </div>
            );
          })
        )}
      </div>

      {!loading && total > rows.length && (
        <div className="px-3 py-2 border-t border-gray-100 bg-gray-50 text-xs text-gray-500">
          Showing {rows.length} of {total} — narrow the search to see the rest.
        </div>
      )}
    </div>
  );
}

// ---- New delegation modal -------------------------------------------------
function NewDelegationModal({
  users,
  onClose,
  onCreated,
}: {
  users: OrgUser[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const toast = useToast();
  const today = new Date().toISOString().slice(0, 10);
  const [delegator, setDelegator] = useState<OrgUser | null>(null);
  const [delegate, setDelegate] = useState<OrgUser | null>(null);
  const [reason, setReason] = useState('');
  const [attachments, setAttachments] = useState<File[]>([]);
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState('');
  const [scope, setScope] = useState<'specific' | 'all'>('specific');
  const [selectedRequests, setSelectedRequests] = useState<Map<string, CandidateRequest>>(new Map());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Changing either party invalidates the picked requests — the candidate list
  // and the conflict checks are both specific to that pair.
  useEffect(() => { setSelectedRequests(new Map()); }, [delegator?.id, delegate?.id]);

  const toggleRequest = (id: string, row: CandidateRequest) => {
    setSelectedRequests((prev) => {
      const next = new Map(prev);
      if (next.has(id)) next.delete(id);
      else next.set(id, row);
      return next;
    });
  };

  const handleSubmit = async () => {
    setError(null);
    if (!delegator || !delegate) { setError('Choose who is away and who will cover for them.'); return; }
    if (!reason.trim()) { setError('A reason is required.'); return; }
    if (attachments.length === 0) { setError('Attach at least one supporting image for the reason.'); return; }
    if (!endDate) { setError('Choose an end date.'); return; }
    if (endDate < startDate) { setError('The end date must be on or after the start date.'); return; }
    if (scope === 'specific' && selectedRequests.size === 0) {
      setError('Pick the requests to delegate, or switch to “every approval” below.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch('/api/admin/delegations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          delegatorId: delegator.id,
          delegateId: delegate.id,
          reason: reason.trim(),
          startsAt: new Date(`${startDate}T00:00:00`).toISOString(),
          endsAt: new Date(`${endDate}T23:59:59`).toISOString(),
          scope,
          requestIds: scope === 'specific' ? Array.from(selectedRequests.keys()) : [],
          attachmentCount: attachments.length,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create delegation');

      // Upload the supporting images against the freshly-created delegation.
      // Evidence is mandatory, so a delegation that ends up with none is
      // revoked rather than left standing unsupported.
      let uploaded = 0;
      for (const file of attachments) {
        try {
          const fd = new FormData();
          fd.append('file', file);
          const up = await fetch(`/api/admin/delegations/${data.id}/documents`, { method: 'POST', body: fd });
          if (up.ok) uploaded++;
        } catch {
          /* counted as a failure below */
        }
      }
      if (uploaded === 0) {
        await fetch(`/api/admin/delegations/${data.id}`, { method: 'DELETE' }).catch(() => {});
        throw new Error('The supporting image could not be uploaded, so the delegation was not created. Please try again.');
      }
      if (uploaded < attachments.length) {
        toast.addToast({
          type: 'warning',
          message: `Delegation created, but ${attachments.length - uploaded} image(s) failed to upload.`,
        });
      }

      toast.addToast({ type: 'success', message: 'Delegation created' });
      onCreated();
      onClose();
    } catch (e: any) {
      setError(e.message || 'Failed to create delegation');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-2xl mx-4 max-h-[92vh] overflow-hidden flex flex-col">
        <div className="p-6 border-b border-gray-100 flex items-center justify-between">
          <div>
            <h2 className="text-xl font-bold text-gray-900">New delegation</h2>
            <p className="text-sm text-gray-500 mt-1">Route one person&apos;s approvals to another for a set period.</p>
          </div>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-gray-100"><X className="w-5 h-5 text-gray-500" /></button>
        </div>

        <div className="p-6 space-y-5 overflow-y-auto">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Approver who is away <span className="text-red-500">*</span></label>
            <UserSelect users={users} value={delegator} onChange={setDelegator} placeholder="Search for the approver…" excludeId={delegate?.id} />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Delegate (covers their approvals) <span className="text-red-500">*</span></label>
            <UserSelect users={users} value={delegate} onChange={setDelegate} placeholder="Search for the delegate…" excludeId={delegator?.id} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Start</label>
              <input type="date" value={startDate} min={today} onChange={(e) => setStartDate(e.target.value)} className="w-full px-3 py-2.5 rounded-xl border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">End <span className="text-red-500">*</span></label>
              <input type="date" value={endDate} min={startDate || today} onChange={(e) => setEndDate(e.target.value)} className="w-full px-3 py-2.5 rounded-xl border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Reason <span className="text-red-500">*</span></label>
            <textarea
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. On annual leave 5–19 Aug; cover approvals to keep requests moving."
              className="w-full px-3 py-2.5 rounded-xl border border-gray-300 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
          </div>

          {/* Supporting images for the reason (e.g. a photo/scan of a leave approval). */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Supporting images <span className="text-red-500">*</span>
            </label>
            <p className="text-xs text-gray-500 mb-2">
              Attach the evidence behind the reason — a leave approval, an email, a signed memo. At least one image is required.
            </p>
            <label className="flex items-center gap-2 cursor-pointer w-fit px-3 py-2 rounded-xl border border-dashed border-gray-300 text-sm text-gray-600 hover:bg-gray-50">
              <ImagePlus className="w-4 h-4 text-primary-600" />
              <span>Add images</span>
              <input
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => {
                  const picked = Array.from(e.target.files || []);
                  if (picked.length) setAttachments((prev) => [...prev, ...picked]);
                  e.target.value = '';
                }}
              />
            </label>
            {attachments.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {attachments.map((file, i) => (
                  <div key={i} className="relative group w-20 h-20 rounded-lg overflow-hidden border border-gray-200 bg-gray-50">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={URL.createObjectURL(file)} alt={file.name} className="w-full h-full object-cover" />
                    <button
                      type="button"
                      onClick={() => setAttachments((prev) => prev.filter((_, idx) => idx !== i))}
                      className="absolute top-0.5 right-0.5 p-0.5 rounded bg-black/50 text-white opacity-0 group-hover:opacity-100 transition-opacity"
                      aria-label={`Remove ${file.name}`}
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {delegator && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                What does this delegation cover? <span className="text-red-500">*</span>
              </label>
              <div className="grid sm:grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => setScope('specific')}
                  className={`text-left p-3 rounded-xl border-2 transition-colors ${
                    scope === 'specific' ? 'border-primary-500 bg-primary-50' : 'border-gray-200 hover:border-gray-300'
                  }`}
                >
                  <span className="flex items-center gap-2 text-sm font-semibold text-gray-900">
                    <ShieldCheck className="w-4 h-4 text-primary-600" /> Only the requests I pick
                  </span>
                  <span className="block text-xs text-gray-500 mt-1">
                    Nothing else that reaches {delegator.display_name} is delegated.
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setScope('all')}
                  className={`text-left p-3 rounded-xl border-2 transition-colors ${
                    scope === 'all' ? 'border-amber-500 bg-amber-50' : 'border-gray-200 hover:border-gray-300'
                  }`}
                >
                  <span className="flex items-center gap-2 text-sm font-semibold text-gray-900">
                    <AlertTriangle className="w-4 h-4 text-amber-600" /> Every approval in the window
                  </span>
                  <span className="block text-xs text-gray-500 mt-1">
                    All of {delegator.display_name}&apos;s approvals route to the delegate until the end date.
                  </span>
                </button>
              </div>

              {scope === 'all' ? (
                <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
                  Every request that reaches {delegator.display_name} between the start and end dates will be signed by the
                  delegate — including requests raised after today. Only choose this for a genuine full handover.
                </div>
              ) : (
                <div className="mt-3">
                  <p className="text-xs text-gray-500 mb-2">
                    Search {delegator.display_name}&apos;s live approvals and tick the ones to hand over. Open any request in a
                    new tab to check it first.
                  </p>
                  <RequestPicker
                    delegatorId={delegator.id}
                    delegatorName={delegator.display_name}
                    delegateId={delegate?.id}
                    selected={new Set(selectedRequests.keys())}
                    onToggle={toggleRequest}
                  />
                  {selectedRequests.size > 0 && (
                    <div className="mt-3">
                      <p className="text-xs font-medium text-gray-700 mb-1.5">
                        Delegating {selectedRequests.size} request{selectedRequests.size === 1 ? '' : 's'}
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {Array.from(selectedRequests.values()).map((r) => (
                          <span
                            key={r.requestId}
                            className="inline-flex items-center gap-1.5 max-w-full px-2 py-1 rounded-lg bg-primary-50 border border-primary-200 text-xs text-primary-800"
                          >
                            <span className="truncate">{r.referenceCode || r.title}</span>
                            <button
                              type="button"
                              onClick={() => toggleRequest(r.requestId, r)}
                              className="shrink-0 text-primary-500 hover:text-red-500"
                              aria-label={`Remove ${r.title}`}
                            >
                              <X className="w-3 h-3" />
                            </button>
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {error && <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-700">{error}</div>}
        </div>

        <div className="p-6 border-t border-gray-100 bg-gray-50 flex gap-3">
          <Button variant="secondary" className="flex-1" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button variant="primary" className="flex-1" onClick={handleSubmit} isLoading={submitting}>Create delegation</Button>
        </div>
      </div>
    </div>
  );
}

// ---- Page -----------------------------------------------------------------
export default function AdminDelegationsPage() {
  const { hasAnyPermission, loading: rbacLoading } = useRBAC();
  const toast = useToast();
  const canManage = hasAnyPermission(['admin.system_config', 'users.manage_access']);

  const [users, setUsers] = useState<OrgUser[]>([]);
  const [delegations, setDelegations] = useState<Delegation[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const [uRes, dRes] = await Promise.all([
        fetch('/api/users'),
        fetch('/api/admin/delegations'),
      ]);
      if (uRes.ok) setUsers((await uRes.json()).users || []);
      if (dRes.ok) setDelegations((await dRes.json()).delegations || []);
    } catch (e) {
      console.error('Failed to load delegations', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { if (canManage) load(); }, [canManage]);

  const revoke = async (id: string) => {
    if (!confirm('Revoke this delegation? New approvals will route back to the original approver. Approvals already handed over stay with the delegate.')) return;
    setRevoking(id);
    try {
      const res = await fetch(`/api/admin/delegations/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error((await res.json()).error || 'Failed to revoke');
      toast.addToast({ type: 'success', message: 'Delegation revoked' });
      load();
    } catch (e: any) {
      toast.addToast({ type: 'error', message: e.message || 'Failed to revoke' });
    } finally {
      setRevoking(null);
    }
  };

  const { active, past } = useMemo(() => ({
    active: delegations.filter((d) => d.status === 'active'),
    past: delegations.filter((d) => d.status !== 'active'),
  }), [delegations]);

  if (!rbacLoading && !canManage) {
    return (
      <AppLayout title="Delegations">
        <div className="p-6 max-w-3xl mx-auto">
          <Card className="!p-8 text-center text-text-secondary">You don&apos;t have permission to manage delegations.</Card>
        </div>
      </AppLayout>
    );
  }

  const renderRow = (d: Delegation) => (
    <div key={d.id} className="flex flex-col sm:flex-row sm:items-center gap-3 p-4 border border-border rounded-xl bg-white">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-semibold text-text-primary">{d.delegator?.display_name || '—'}</span>
          <span className="text-text-muted text-sm">→</span>
          <span className="text-sm font-semibold text-text-primary">{d.delegate?.display_name || '—'}</span>
          <span className={`text-[11px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full border ${statusStyles[d.status] || statusStyles.revoked}`}>{d.status}</span>
          {d.scope === 'specific' ? (
            <span className="inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full border bg-primary-50 text-primary-700 border-primary-100">
              <ShieldCheck className="w-3 h-3" /> {d.request_ids?.length || 0} request{(d.request_ids?.length || 0) === 1 ? '' : 's'}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full border bg-amber-50 text-amber-700 border-amber-200">
              <AlertTriangle className="w-3 h-3" /> All approvals
            </span>
          )}
        </div>
        <p className="text-sm text-text-secondary mt-1 line-clamp-2">{d.reason}</p>
        <div className="flex items-center gap-1.5 text-xs text-text-muted mt-1.5">
          <CalendarClock className="w-3.5 h-3.5" />
          {fmtDate(d.starts_at)} – {fmtDate(d.ends_at)}
          {d.created_by_user && <span>• set by {d.created_by_user.display_name}</span>}
        </div>
        {d.documents && d.documents.length > 0 && (
          <div className="flex items-center gap-2 mt-2">
            <Paperclip className="w-3.5 h-3.5 text-text-muted shrink-0" />
            <div className="flex flex-wrap gap-1.5">
              {d.documents.map((doc, i) => (
                doc.download_url ? (
                  <a
                    key={i}
                    href={doc.download_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="w-10 h-10 rounded-md overflow-hidden border border-gray-200 hover:ring-2 hover:ring-primary-400"
                    title={doc.name}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={doc.download_url} alt={doc.name} className="w-full h-full object-cover" />
                  </a>
                ) : (
                  <span key={i} className="text-xs text-text-muted">{doc.name}</span>
                )
              ))}
            </div>
          </div>
        )}
      </div>
      {d.status === 'active' && (
        <Button variant="outline" onClick={() => revoke(d.id)} isLoading={revoking === d.id} className="shrink-0">Revoke</Button>
      )}
    </div>
  );

  return (
    <>
      <Head><title>Delegations - The Circle</title></Head>
      <AppLayout title="Delegations">
        <div className="p-4 sm:p-6 max-w-4xl mx-auto">
          <div className="bg-white rounded-2xl border border-border p-6 mb-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <h1 className="text-2xl font-bold text-text-primary tracking-tight flex items-center gap-2">
                <UserCog className="w-6 h-6 text-primary-600" strokeWidth={1.5} /> Delegations
              </h1>
              <p className="text-text-secondary mt-1.5 text-sm max-w-xl">
                When an approver is away, route their approvals to someone else for a set period. New approvals during the window
                automatically go to the delegate, and every delegation is recorded in the audit log.
              </p>
            </div>
            <Button variant="primary" onClick={() => setShowModal(true)} className="shrink-0 flex items-center gap-2">
              <Plus className="w-4 h-4" /> New delegation
            </Button>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-16">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-500" />
            </div>
          ) : (
            <div className="space-y-8">
              <section>
                <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-3">Active ({active.length})</h2>
                {active.length === 0 ? (
                  <Card className="!p-6 text-center text-text-secondary text-sm">No active delegations.</Card>
                ) : (
                  <div className="space-y-3">{active.map(renderRow)}</div>
                )}
              </section>

              {past.length > 0 && (
                <section>
                  <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-3">Past</h2>
                  <div className="space-y-3">{past.map(renderRow)}</div>
                </section>
              )}
            </div>
          )}
        </div>

        {showModal && (
          <NewDelegationModal users={users} onClose={() => setShowModal(false)} onCreated={load} />
        )}
      </AppLayout>
    </>
  );
}
