import { useCurrentUser } from '../../../hooks/useCurrentUser';
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import { AppLayout } from '../../../components/layout';
import { Card, Button, Input } from '../../../components/ui';
import { useToast } from '../../../components/ui/ToastProvider';
import { OnBehalfOfField, type OnBehalfOf } from '../../../components/requests/OnBehalfOfField';
import ApproverSectionLoader from '../../../components/requests/ApproverSectionLoader';

/**
 * Price Variation Form — raised against an already fully-approved CAPEX.
 *
 * A CAPEX price can move after it has been signed off. This form captures the
 * revised pricing (per the RTG Price Variation Form) and runs its own approval
 * chain — Departmental Head -> Procurement Manager -> Finance Manager, plus the
 * Chief Finance Officer when the amount exceeds $5,000. On full approval the
 * variation is linked back onto the parent CAPEX (see
 * ApprovalEngine.linkPriceVariationToParent) so anyone opening the CAPEX can
 * see a pricing variation exists.
 *
 * Navigated to as /requests/new/price-variation?parent=<capexId>.
 */

// Approval chain, in order. `cfo` is appended only when amount > $5,000.
const VARIATION_ROLES = [
  { key: 'department_head', label: 'Departmental Head', resolverKey: 'general_manager' },
  { key: 'procurement_manager', label: 'Procurement Manager', resolverKey: 'procurement_manager' },
  { key: 'finance_manager', label: 'Finance Manager', resolverKey: 'finance_manager' },
  { key: 'cfo', label: 'Chief Finance Officer', resolverKey: 'finance_director' },
] as const;

const CFO_THRESHOLD = 5000;

type UserLite = { id: string; display_name: string; email: string; job_title?: string };

export default function PriceVariationPage() {
  const { data: session, status } = useSession();
  const { user } = useCurrentUser();
  const router = useRouter();
  const { addToast } = useToast();
  const parentId = typeof router.query.parent === 'string' ? router.query.parent : '';

  const [parent, setParent] = useState<{ title: string; metadata: any; status: string; creator_id: string } | null>(null);
  const [loadingParent, setLoadingParent] = useState(true);
  const [parentError, setParentError] = useState<string | null>(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [formData, setFormData] = useState({
    date: new Date().toISOString().slice(0, 10),
    supplierName: '',
    firstQuotation: '',
    secondQuotation: '',
    firstQuotationNumber: '',
    secondQuotationNumber: '',
    firstOrderNumber: '',
    secondOrderNumber: '',
    dateOnQuotation: '',
    amount: '',
    variance: '',
    reason: '',
    requestedBy: '',
  });

  const [users, setUsers] = useState<UserLite[]>([]);
  const [selectedApprovers, setSelectedApprovers] = useState<Record<string, string>>({});
  const [autoResolvedRoles, setAutoResolvedRoles] = useState<Record<string, boolean>>({});
  const [onBehalfOf, setOnBehalfOf] = useState<OnBehalfOf | null>(null);
  const [approverSearch, setApproverSearch] = useState<Record<string, string>>({});
  const [showApproverDropdown, setShowApproverDropdown] = useState<string | null>(null);
  const [loadingApproverResolution, setLoadingApproverResolution] = useState(true);

  const amountNumeric = parseFloat((formData.amount || '').replace(/[^0-9.]/g, '')) || 0;
  const requiresCfo = amountNumeric > CFO_THRESHOLD;
  const activeRoles = VARIATION_ROLES.filter((r) => r.key !== 'cfo' || requiresCfo);

  // Prefill requester name once the user is known.
  useEffect(() => {
    if (user?.display_name && !formData.requestedBy) {
      setFormData((prev) => ({ ...prev, requestedBy: user.display_name || '' }));
    }
  }, [user?.display_name]);

  // Load the parent CAPEX for context + guardrails (must be approved).
  useEffect(() => {
    const loadParent = async () => {
      if (!parentId || status !== 'authenticated') return;
      setLoadingParent(true);
      try {
        const resp = await fetch(`/api/requests/${parentId}`);
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || 'Failed to load the CAPEX request');
        const req = data.request || data;
        setParent({
          title: req.title,
          metadata: req.metadata || {},
          status: req.status,
          creator_id: req.creator_id,
        });
        // Prefill supplier from the CAPEX's selected quotation when available.
        const capexMeta = req.metadata?.capex || req.metadata || {};
        const selectedQuote = (capexMeta.quotations || []).find((q: any) => q.isSelectedSupplier);
        setFormData((prev) => ({
          ...prev,
          supplierName: prev.supplierName || selectedQuote?.supplierName || '',
        }));
      } catch (err: any) {
        setParentError(err.message || 'Failed to load the CAPEX request');
      } finally {
        setLoadingParent(false);
      }
    };
    loadParent();
  }, [parentId, status]);

  // Load an initial user pool (for selected-name lookups + staging list).
  useEffect(() => {
    const fetchUsers = async () => {
      try {
        const resp = await fetch('/api/users');
        if (resp.ok) {
          const data = await resp.json();
          setUsers(data.users || []);
        }
      } catch (err) {
        console.error('Failed to fetch users:', err);
      }
    };
    if (status === 'authenticated') fetchUsers();
  }, [status]);

  // Auto-resolve the variation approval chain from HRIMS. The variation chain
  // maps onto the CAPEX resolver roles, so we reuse formType=capex.
  useEffect(() => {
    const resolveApprovers = async () => {
      if (!session?.user?.email) return;
      setLoadingApproverResolution(true);
      try {
        const resp = await fetch(
          `/api/hrims/resolve-approvers?email=${encodeURIComponent(session.user.email)}&formType=capex`
        );
        const data = await resp.json();
        if (resp.ok && data.approvers) {
          const resolved: Record<string, boolean> = {};
          const newApprovers: Record<string, string> = {};
          for (const role of VARIATION_ROLES) {
            const approver = data.approvers[role.resolverKey];
            if (approver && approver.userId) {
              newApprovers[role.key] = approver.userId;
              resolved[role.key] = true;
            }
          }
          if (Object.keys(newApprovers).length > 0) {
            setSelectedApprovers((prev) => ({ ...prev, ...newApprovers }));
            setAutoResolvedRoles(resolved);
          }
        }
      } catch (err) {
        console.error('Failed to auto-resolve approvers:', err);
      } finally {
        setLoadingApproverResolution(false);
      }
    };
    if (status === 'authenticated') resolveApprovers();
  }, [status, session?.user?.email]);

  // Directory search for the currently-open approver picker (Azure AD in prod).
  const activeTerm = showApproverDropdown ? approverSearch[showApproverDropdown] || '' : '';
  useEffect(() => {
    const term = activeTerm.trim();
    if (term.length < 2) return;
    const handle = setTimeout(async () => {
      try {
        const resp = await fetch(`/api/users/search?q=${encodeURIComponent(term)}`);
        if (!resp.ok) return;
        const data = await resp.json();
        const found = (data.users || []) as UserLite[];
        if (found.length === 0) return;
        setUsers((prev) => {
          const map = new Map(prev.map((u) => [u.id, u]));
          for (const u of found) if (!map.has(u.id)) map.set(u.id, u);
          return Array.from(map.values());
        });
      } catch (err) {
        console.error('User directory search failed:', err);
      }
    }, 300);
    return () => clearTimeout(handle);
  }, [activeTerm]);

  const getFilteredUsersForRole = (roleKey: string) => {
    const term = (approverSearch[roleKey] || '').toLowerCase();
    const alreadySelected = Object.entries(selectedApprovers)
      .filter(([k]) => k !== roleKey)
      .map(([, v]) => v)
      .filter(Boolean);
    // The requester can never approve their own request — hide themselves from the picker.
    const currentUserId = (session?.user as any)?.id;
    return users
      .filter((u) => u.id !== currentUserId)
      .filter((u) => !alreadySelected.includes(u.id))
      .filter((u) =>
        term
          ? u.display_name?.toLowerCase().includes(term) || u.email?.toLowerCase().includes(term)
          : true
      )
      .slice(0, 25);
  };

  const selectApprover = (roleKey: string, userId: string) => {
    setSelectedApprovers((prev) => ({ ...prev, [roleKey]: userId }));
    setAutoResolvedRoles((prev) => ({ ...prev, [roleKey]: false }));
    setApproverSearch((prev) => ({ ...prev, [roleKey]: '' }));
    setShowApproverDropdown(null);
  };

  const handleSubmit = async () => {
    setError(null);

    if (!parentId || !parent) {
      setError('This variation is not linked to a CAPEX request.');
      return;
    }
    if (parent.status !== 'approved') {
      setError('A price variation can only be raised against a fully approved CAPEX.');
      return;
    }
    if (!formData.supplierName || !formData.amount || !formData.reason) {
      setError('Supplier name, amount and the reason for the variance are required.');
      return;
    }

    const missing = activeRoles.filter((r) => !selectedApprovers[r.key]);
    if (missing.length > 0) {
      setError(`Please assign: ${missing.map((r) => r.label).join(', ')}.`);
      return;
    }

    const approversArray = activeRoles.map((r) => selectedApprovers[r.key]).filter(Boolean);

    setLoading(true);
    try {
      const parentProjectName =
        parent.metadata?.projectName || parent.metadata?.capex?.projectName || parent.title;

      const resp = await fetch('/api/requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: `Price Variation: ${parentProjectName}`,
          description: formData.reason,
          priority: 'high',
          requestType: 'price-variation',
          status: 'pending',
          metadata: {
            type: 'price-variation',
            parentRequestId: parentId,
            parentTitle: parent.title,
            currency: parent.metadata?.currency || parent.metadata?.capex?.currency || 'USD',
            ...formData,
            approvers: approversArray,
            approverRoles: Object.fromEntries(activeRoles.map((r) => [r.key, selectedApprovers[r.key]])),
            requiresCfo,
            onBehalfOf: onBehalfOf || null,
          },
        }),
      });

      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Failed to submit the price variation');

      addToast({ type: 'success', message: 'Price variation submitted for approval.' });
      router.push(`/requests/${parentId}`);
    } catch (err: any) {
      setError(err.message || 'Failed to submit the price variation');
    } finally {
      setLoading(false);
    }
  };

  const currencySymbol =
    (parent?.metadata?.currency || parent?.metadata?.capex?.currency) === 'ZIG' ? 'ZiG' : '$';

  if (status === 'loading' || loadingParent) {
    return (
      <AppLayout>
        <div className="max-w-3xl mx-auto p-6">
          <div className="animate-pulse text-text-secondary">Loading…</div>
        </div>
      </AppLayout>
    );
  }

  if (parentError || !parent) {
    return (
      <AppLayout>
        <div className="max-w-3xl mx-auto p-6">
          <Card>
            <p className="text-danger-600">{parentError || 'CAPEX request not found.'}</p>
            <Button className="mt-4" onClick={() => router.back()}>Go back</Button>
          </Card>
        </div>
      </AppLayout>
    );
  }

  const notApproved = parent.status !== 'approved';

  return (
    <AppLayout>
      <div className="max-w-3xl mx-auto p-4 md:p-6 space-y-6">
        <div>
          <button onClick={() => router.push(`/requests/${parentId}`)} className="text-sm text-primary-600 hover:underline mb-2">
            ← Back to CAPEX
          </button>
          <h1 className="text-2xl font-bold text-text-primary">Price Variation Form</h1>
          <p className="text-sm text-text-secondary mt-1">
            Against <span className="font-medium">{parent.title}</span>
          </p>
        </div>

        {notApproved && (
          <Card>
            <p className="text-amber-700 text-sm">
              This CAPEX is not fully approved yet. A price variation can only be raised once the CAPEX
              has been fully signed and approved.
            </p>
          </Card>
        )}

        {error && (
          <div className="rounded-xl border border-danger-200 bg-danger-50 text-danger-700 text-sm px-4 py-3">
            {error}
          </div>
        )}

        {/* Filing on behalf of — shown at the top; only assigned assistants see it */}
        <Card>
          <OnBehalfOfField value={onBehalfOf} onChange={setOnBehalfOf} />
        </Card>

        {/* Variation details */}
        <Card>
          <h3 className="font-semibold text-text-primary mb-4 text-lg">Variation Details</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Date</label>
              <Input type="date" value={formData.date} onChange={(e) => setFormData({ ...formData, date: e.target.value })} />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Name of the Supplier <span className="text-red-500">*</span></label>
              <Input value={formData.supplierName} onChange={(e) => setFormData({ ...formData, supplierName: e.target.value })} placeholder="Supplier name" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">First Quotation ({currencySymbol})</label>
              <Input value={formData.firstQuotation} onChange={(e) => setFormData({ ...formData, firstQuotation: e.target.value })} placeholder="0.00" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Second Quotation ({currencySymbol})</label>
              <Input value={formData.secondQuotation} onChange={(e) => setFormData({ ...formData, secondQuotation: e.target.value })} placeholder="0.00" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">First Quotation Number</label>
              <Input value={formData.firstQuotationNumber} onChange={(e) => setFormData({ ...formData, firstQuotationNumber: e.target.value })} placeholder="Quotation no. for 1st" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Second Quotation Number</label>
              <Input value={formData.secondQuotationNumber} onChange={(e) => setFormData({ ...formData, secondQuotationNumber: e.target.value })} placeholder="Quotation no. for 2nd" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">First Order Number</label>
              <Input value={formData.firstOrderNumber} onChange={(e) => setFormData({ ...formData, firstOrderNumber: e.target.value })} placeholder="RTG order no. for 1st" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Second Order Number</label>
              <Input value={formData.secondOrderNumber} onChange={(e) => setFormData({ ...formData, secondOrderNumber: e.target.value })} placeholder="RTG order no. for 2nd" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Date on Quotation</label>
              <Input type="date" value={formData.dateOnQuotation} onChange={(e) => setFormData({ ...formData, dateOnQuotation: e.target.value })} />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Amount ({currencySymbol}) <span className="text-red-500">*</span></label>
              <Input value={formData.amount} onChange={(e) => setFormData({ ...formData, amount: e.target.value })} placeholder="0.00" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Variance between 1st &amp; 2nd Quotation</label>
              <Input value={formData.variance} onChange={(e) => setFormData({ ...formData, variance: e.target.value })} placeholder="e.g. 12% or amount" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Requested By</label>
              <Input value={formData.requestedBy} onChange={(e) => setFormData({ ...formData, requestedBy: e.target.value })} />
            </div>
          </div>
          <div className="mt-4">
            <label className="block text-sm font-medium text-gray-700 mb-1">Reason for Price Variance (as stated on the revised quotation) <span className="text-red-500">*</span></label>
            <textarea
              className="w-full px-4 py-3 min-h-[100px] rounded-xl border border-gray-300 bg-white text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent resize-none transition-all"
              value={formData.reason}
              onChange={(e) => setFormData({ ...formData, reason: e.target.value })}
              placeholder="Explain the reason for the price variation…"
            />
          </div>
        </Card>

        {/* Approval chain */}
        <Card>
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold text-text-primary text-lg">Approval Chain</h3>
            {loadingApproverResolution && <span className="text-xs text-text-secondary">Resolving approvers…</span>}
          </div>
          <p className="text-sm text-text-secondary mb-4">
            {requiresCfo
              ? 'Amount exceeds $5,000 — the Chief Finance Officer must also authorise.'
              : 'For amounts of $5,000 or below the Chief Finance Officer step is not required.'}
          </p>
          {loadingApproverResolution && <ApproverSectionLoader rows={activeRoles.length} />}
          <div className={`space-y-3 ${loadingApproverResolution ? 'hidden' : ''}`}>
            {activeRoles.map((role, index) => {
              const selectedId = selectedApprovers[role.key];
              const selectedUser = users.find((u) => u.id === selectedId);
              return (
                <div key={role.key} className="relative border border-gray-200 rounded-xl p-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium text-gray-900">{index + 1}. {role.label}</p>
                      {selectedUser ? (
                        <p className="text-xs text-text-secondary">
                          {selectedUser.display_name} · {selectedUser.email}
                          {autoResolvedRoles[role.key] && <span className="ml-2 text-primary-600">auto-resolved</span>}
                        </p>
                      ) : (
                        <p className="text-xs text-amber-600">Not assigned</p>
                      )}
                    </div>
                    <button
                      type="button"
                      className="text-xs text-primary-600 hover:underline"
                      onClick={() => setShowApproverDropdown(showApproverDropdown === role.key ? null : role.key)}
                    >
                      {selectedUser ? 'Change' : 'Assign'}
                    </button>
                  </div>

                  {showApproverDropdown === role.key && (
                    <div className="mt-2">
                      <Input
                        autoFocus
                        placeholder="Search by name or email…"
                        value={approverSearch[role.key] || ''}
                        onChange={(e) => setApproverSearch((prev) => ({ ...prev, [role.key]: e.target.value }))}
                      />
                      <div className="mt-1 max-h-52 overflow-y-auto border border-gray-100 rounded-lg">
                        {getFilteredUsersForRole(role.key).map((u) => (
                          <button
                            key={u.id}
                            type="button"
                            onClick={() => selectApprover(role.key, u.id)}
                            className="w-full px-3 py-2 text-left hover:bg-primary-50 flex items-center gap-2 border-b border-gray-50 last:border-b-0"
                          >
                            <div className="w-7 h-7 rounded-full bg-primary-100 flex items-center justify-center text-xs font-medium text-primary-600">
                              {u.display_name?.charAt(0)?.toUpperCase() || '?'}
                            </div>
                            <div className="min-w-0">
                              <p className="text-sm text-gray-900 truncate">{u.display_name}</p>
                              <p className="text-xs text-gray-500 truncate">{u.email}</p>
                            </div>
                          </button>
                        ))}
                        {getFilteredUsersForRole(role.key).length === 0 && (
                          <p className="px-3 py-2 text-sm text-gray-500">No users found</p>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Card>

        <div className="flex justify-end gap-3">
          <Button variant="secondary" onClick={() => router.push(`/requests/${parentId}`)}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={loading || notApproved}>
            {loading ? 'Submitting…' : 'Submit for Approval'}
          </Button>
        </div>
      </div>
    </AppLayout>
  );
}
