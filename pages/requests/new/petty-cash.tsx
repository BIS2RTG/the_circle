import { useSession } from 'next-auth/react';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import { AppLayout } from '../../../components/layout';
import { Card, Button, Input, RequestPreviewModal, UnsavedChangesModal, ReferenceCodeBanner } from '../../../components/ui';
import type { PreviewSection } from '../../../components/ui';
import { useCurrentUser } from '../../../hooks/useCurrentUser';
import { useUnsavedChangesPrompt, useFormAutosave } from '../../../hooks';
import { useUserHrimsProfile } from '../../../hooks/useUserHrimsProfile';
import SignatureSelector, { type SignatureSelection } from '../../../components/approvals/SignatureSelector';
import { OnBehalfOfField, type OnBehalfOf } from '../../../components/requests/OnBehalfOfField';
import ApproverSectionLoader from '../../../components/requests/ApproverSectionLoader';

// Cost-allocation business units mirror the travel-auth allocation list.
// Code is stored in metadata; label is shown in the dropdown.
const CHARGE_TO_OPTIONS: Array<{ code: string; label: string }> = [
    { code: 'CORP', label: 'Corporate (CORP)' },
    { code: 'MRC', label: 'Montclair Resort and Conferencing (MRC)' },
    { code: 'NAH', label: 'New Ambassador Hotel (NAH)' },
    { code: 'RTH', label: 'Rainbow Towers Hotel (RTH)' },
    { code: 'KHCC', label: 'KHCC Conference Centre (KHCC)' },
    { code: 'BRH', label: 'Bulawayo Rainbow Hotel (BRH)' },
    { code: 'VFRH', label: 'Victoria Falls Rainbow Hotel (VFRH)' },
    { code: 'AZAM', label: "A'Zambezi River Lodge (AZAM)" },
];

interface PettyCashLineItem {
    description: string;
    amount: string;
    quantity: string;
    chargeTo: string;
}

interface SupportingDocument {
    file: File;
    label: string;
    description: string;
}

interface LinkedApprovedRequest {
    id: string;
    title: string;
    referenceCode: string | null;
    requestType: string;
    approvedAt: string | null;
}

const emptyLineItem = (): PettyCashLineItem => ({ description: '', amount: '', quantity: '1', chargeTo: '' });

// Line total = unit amount × quantity.
const lineItemTotal = (row: PettyCashLineItem): number =>
    (parseFloat(row.amount) || 0) * (parseFloat(row.quantity) || 0);

const emptySignature: SignatureSelection = { type: 'manual', data: '' };

export default function PettyCashRequestPage() {
    const { data: session, status } = useSession();
    const router = useRouter();
    const { user } = useCurrentUser();
    const { departmentName, businessUnitName, profile } = useUserHrimsProfile();

    // "Charge To" lists the departments within the requestor's own business
    // unit (from HRIMS). Falls back to the fixed business-unit list if HRIMS is
    // unreachable or returns nothing, so the field is never empty.
    const [chargeToDepts, setChargeToDepts] = useState<Array<{ id: string; name: string; code?: string }>>([]);
    const requestorBusinessUnitId = profile?.businessUnit?.id || profile?.employee?.business_unit_id || null;
    useEffect(() => {
        if (!requestorBusinessUnitId) return;
        let cancelled = false;
        fetch(`/api/hrims/departments?business_unit_id=${encodeURIComponent(requestorBusinessUnitId)}`)
            .then((r) => r.json())
            .then((d) => { if (!cancelled) setChargeToDepts(Array.isArray(d.departments) ? d.departments : []); })
            .catch(() => { /* keep fallback */ });
        return () => { cancelled = true; };
    }, [requestorBusinessUnitId]);

    const chargeToOptions = chargeToDepts.length > 0
        ? chargeToDepts.map((d) => ({ value: d.name, label: d.name }))
        : CHARGE_TO_OPTIONS.map((o) => ({ value: o.code, label: o.label }));

    const chargeToLabel = (val: string) =>
        chargeToDepts.find((d) => d.name === val)?.name
        || CHARGE_TO_OPTIONS.find((o) => o.code === val)?.label
        || val
        || '—';

    // Edit-mode and approver-edit-mode parameters mirror the other forms.
    const { edit: editRequestId, approver: isApproverEdit, linkedTo } = router.query;
    const isEditMode = !!editRequestId;
    const isApproverEditing = isApproverEdit === 'true';
    const linkedTravelAuthId = typeof linkedTo === 'string' ? linkedTo : null;

    const [loading, setLoading] = useState(false);
    const [savingDraft, setSavingDraft] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [loadingRequest, setLoadingRequest] = useState(false);
    const [requestStatus, setRequestStatus] = useState<string>('draft');
    const [referenceCode, setReferenceCode] = useState<string | null>(null);
    const [existingReferenceCode, setExistingReferenceCode] = useState<string | null>(null);

    // Linked travel-auth context — populated when the user lands here from the
    // post-approval CTA on a travel-auth detail page (?linkedTo=<id>).
    const [linkedTravelAuth, setLinkedTravelAuth] = useState<{
        id: string;
        title: string;
        referenceCode?: string;
        purposeOfTravel?: string;
        dateOfIntendedTravel?: string;
    } | null>(null);

    const today = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const todayISO = new Date().toISOString().split('T')[0];

    const [formData, setFormData] = useState({
        receiptDate: todayISO,
        receivedBy: '',
        receivedDate: todayISO,
        isExternalRecipient: false,
        externalIdNumber: '',
        purpose: '',
    });

    const [lineItems, setLineItems] = useState<PettyCashLineItem[]>([emptyLineItem()]);
    const [recipientSignature, setRecipientSignature] = useState<SignatureSelection>(emptySignature);

    const [supportingDocuments, setSupportingDocuments] = useState<SupportingDocument[]>([]);
    const [existingSupportingDocs, setExistingSupportingDocs] = useState<any[]>([]);

    // User-attached links to other in-system approved requests (CAPEX, travel
    // auth, etc.) so the finance approvers can trace the petty cash back to
    // the originating approval. Stored as opaque rows; we keep the parent
    // request's id/title/refcode so links survive even if the parent is
    // archived later.
    const [linkedApprovedRequests, setLinkedApprovedRequests] = useState<LinkedApprovedRequest[]>([]);
    const [linkSearch, setLinkSearch] = useState('');
    const [linkSearchResults, setLinkSearchResults] = useState<LinkedApprovedRequest[]>([]);
    const [linkSearchLoading, setLinkSearchLoading] = useState(false);
    const [linkSearchError, setLinkSearchError] = useState<string | null>(null);

    // Original snapshots for approver-edit change tracking.
    const [originalFormData, setOriginalFormData] = useState<typeof formData | null>(null);
    const [originalLineItems, setOriginalLineItems] = useState<PettyCashLineItem[] | null>(null);
    const [originalApprovers, setOriginalApprovers] = useState<Record<string, string> | null>(null);

    // Unsaved-changes tracking — flipped true on first real user interaction.
    const [isDirty, setIsDirty] = useState(false);

    // Approver workflow: Department Head -> Accountant -> Finance Manager (sequential).
    const approvalRoles = [
        { key: 'department_head', label: 'Department Head', description: 'First Approval' },
        { key: 'accountant', label: 'Accountant', description: 'Finance Verification' },
        { key: 'finance_manager', label: 'Finance Manager', description: 'Final Authorisation' },
    ];
    const [users, setUsers] = useState<Array<{ id: string; display_name: string; email: string; job_title?: string }>>([]);
    const [loadingUsers, setLoadingUsers] = useState(true);
    const [selectedApprovers, setSelectedApprovers] = useState<Record<string, string>>({
        department_head: '', accountant: '', finance_manager: '',
    });
    const [approverSearch, setApproverSearch] = useState<Record<string, string>>({
        department_head: '', accountant: '', finance_manager: '',
    });
    const [showApproverDropdown, setShowApproverDropdown] = useState<string | null>(null);
    const [loadingApproverResolution, setLoadingApproverResolution] = useState(!isEditMode);
    const [autoResolvedRoles, setAutoResolvedRoles] = useState<Record<string, boolean>>({});

    // Watchers (reuse same pattern as voucher form).
    const [selectedWatchers, setSelectedWatchers] = useState<Array<{ id: string; display_name: string; email: string }>>([]);
    const [onBehalfOf, setOnBehalfOf] = useState<OnBehalfOf | null>(null);
    const [watcherSearch, setWatcherSearch] = useState('');
    const [showWatcherDropdown, setShowWatcherDropdown] = useState(false);

    const [showPreview, setShowPreview] = useState(false);
    const [showConfirm, setShowConfirm] = useState(false);

    // Autosave / crash recovery for new requests. Disabled in edit mode and when
    // prefilling from a linked travel auth, where the server owns the data.
    // Only serializable slices are persisted (signatures / file uploads excluded).
    useFormAutosave({
        formKey: 'petty-cash',
        enabled: !isEditMode && !linkedTravelAuthId,
        data: { formData, lineItems, selectedApprovers, selectedWatchers },
        onRestore: (saved) => {
            if (saved.formData) setFormData(saved.formData);
            if (Array.isArray(saved.lineItems) && saved.lineItems.length > 0) {
                setLineItems(saved.lineItems.map((li: any) => ({ quantity: '1', ...li })));
            }
            if (saved.selectedApprovers) setSelectedApprovers(prev => ({ ...prev, ...saved.selectedApprovers }));
            if (Array.isArray(saved.selectedWatchers)) setSelectedWatchers(saved.selectedWatchers);
            setIsDirty(true);
        },
    });

    useEffect(() => {
        if (status === 'unauthenticated') {
            router.push('/');
        }
    }, [status, router]);

    // Fetch existing request data when in edit mode.
    useEffect(() => {
        const fetchExistingRequest = async () => {
            if (!editRequestId || typeof editRequestId !== 'string') return;
            setLoadingRequest(true);
            try {
                const response = await fetch(`/api/requests/${editRequestId}`);
                if (!response.ok) throw new Error('Failed to fetch request');
                const data = await response.json();
                const request = data.request;
                const metadata = request.metadata || {};

                setRequestStatus(request.status || 'draft');
                if (metadata.referenceCode) setExistingReferenceCode(metadata.referenceCode);

                const restored = {
                    receiptDate: metadata.receiptDate || todayISO,
                    receivedBy: metadata.receivedBy?.name || '',
                    receivedDate: metadata.receivedBy?.date || todayISO,
                    isExternalRecipient: metadata.receivedBy?.isExternal || false,
                    externalIdNumber: metadata.receivedBy?.externalIdNumber || '',
                    purpose: metadata.purpose || request.description || '',
                };
                setFormData(restored);
                setOriginalFormData(restored);

                if (Array.isArray(metadata.lineItems) && metadata.lineItems.length > 0) {
                    const withQty = metadata.lineItems.map((li: any) => ({ quantity: '1', ...li }));
                    setLineItems(withQty);
                    setOriginalLineItems(withQty);
                }

                if (metadata.receivedBy?.signature) {
                    setRecipientSignature(metadata.receivedBy.signature);
                }

                if (metadata.linkedTravelAuth) {
                    setLinkedTravelAuth(metadata.linkedTravelAuth);
                }

                const approverRolesData = metadata.approverRoles || {};
                if (approverRolesData && typeof approverRolesData === 'object') {
                    setSelectedApprovers(prev => ({ ...prev, ...approverRolesData }));
                    setOriginalApprovers({ department_head: '', accountant: '', finance_manager: '', ...approverRolesData });
                }

                if (metadata.supportingDocuments && Array.isArray(metadata.supportingDocuments)) {
                    setExistingSupportingDocs(metadata.supportingDocuments);
                } else if (Array.isArray(request.documents) && request.documents.length > 0) {
                    setExistingSupportingDocs(request.documents.map((doc: any) => ({
                        name: doc.filename,
                        size: doc.file_size,
                        type: doc.mime_type,
                        label: doc.document_type || 'Supporting Document',
                        description: '',
                        documentId: doc.id,
                    })));
                }

                if (Array.isArray(metadata.watchers)) setSelectedWatchers(metadata.watchers);

                if (Array.isArray(metadata.linkedApprovedRequests)) {
                    setLinkedApprovedRequests(metadata.linkedApprovedRequests);
                }
            } catch (err: any) {
                console.error('Error fetching petty cash request:', err);
                setError('Failed to load request data');
            } finally {
                setLoadingRequest(false);
            }
        };
        if (status === 'authenticated' && editRequestId) {
            fetchExistingRequest();
        }
    }, [editRequestId, status, todayISO]);

    // Pre-fill from a fully-approved travel-auth when arriving via ?linkedTo=<id>.
    // We populate line items from the travel auth's budget breakdown so the
    // requester (and downstream approvers) see the same expense categories
    // and amounts that were already approved. These fields are then locked
    // — the user can't change the amount or allocation once it's been
    // signed off on at travel-auth time.
    useEffect(() => {
        const fetchLinkedTravelAuth = async () => {
            if (!linkedTravelAuthId || isEditMode) return;
            try {
                const response = await fetch(`/api/requests/${linkedTravelAuthId}`);
                if (!response.ok) return;
                const data = await response.json();
                const request = data.request;
                const metadata = request?.metadata || {};

                // The CTA can hand us either a pure travel auth, or a
                // hotel/voucher/comp booking that bundled a travel document.
                // For the latter, the trip data lives under `travelDocument`
                // rather than at the top of metadata — mirror the same
                // unification autoPettyCash performs.
                const parentType = metadata.type || metadata.requestType;
                const isCompWithTravel = (
                    parentType === 'hotel_booking'
                    || parentType === 'external_hotel_booking'
                    || parentType === 'voucher_request'
                ) && metadata.processTravelDocument && metadata.travelDocument;

                const travelSource: any = isCompWithTravel
                    ? {
                        ...metadata.travelDocument,
                        costAllocation: metadata.costAllocation || metadata.travelDocument?.costAllocation,
                    }
                    : metadata;

                setLinkedTravelAuth({
                    id: request.id,
                    title: request.title,
                    referenceCode: metadata.referenceCode,
                    purposeOfTravel: travelSource.purposeOfTravel,
                    dateOfIntendedTravel: travelSource.dateOfIntendedTravel,
                });

                // Seed the purpose so the requester only fills in line items.
                setFormData(prev => ({
                    ...prev,
                    purpose: prev.purpose || (travelSource.purposeOfTravel ? `Petty cash for: ${travelSource.purposeOfTravel}` : ''),
                    receivedBy: prev.receivedBy || user?.display_name || session?.user?.name || '',
                }));

                // Determine the HRD's cost-allocation. Each line item picks up
                // the dominant allocation unit — if the trip was split (e.g.
                // 60% MRC / 40% NAH) the line items are stamped with the
                // primary unit. The full allocation breakdown is still
                // available on the linked travel auth for audit.
                const allocation: Record<string, string> = travelSource.costAllocation || {};
                const dominantCode = Object.entries(allocation)
                    .filter(([, v]) => parseFloat(String(v)) > 0)
                    .sort(([, a], [, b]) => parseFloat(String(b)) - parseFloat(String(a)))
                    .map(([k]) => k.toUpperCase())[0];

                const chargeTo = dominantCode && CHARGE_TO_OPTIONS.some(o => o.code === dominantCode)
                    ? dominantCode
                    : '';

                // Build line items from the budget breakdown. Each non-zero
                // budget category becomes a line; the description is the
                // category label and the amount is its totalCost. Key names
                // mirror lib/autoPettyCash so the manual fallback and the
                // auto-generated voucher produce identical rows.
                const budget = travelSource.budget || {};
                const budgetCategories: Array<{ key: string; label: string }> = [
                    { key: 'fuel', label: 'Fuel' },
                    { key: 'aaRates', label: 'AA Rates (Personal Vehicle)' },
                    { key: 'airBusTickets', label: 'Air / Bus Tickets' },
                    { key: 'lunchDinner', label: 'Lunch / Dinner' },
                    { key: 'conferencingCost', label: 'Conferencing Cost' },
                ];

                const generatedItems: PettyCashLineItem[] = [];
                for (const cat of budgetCategories) {
                    const entry = budget[cat.key];
                    const amount = parseFloat(entry?.totalCost ?? '0');
                    if (Number.isFinite(amount) && amount > 0) {
                        generatedItems.push({
                            description: cat.label,
                            amount: amount.toFixed(2),
                            quantity: '1',
                            chargeTo,
                        });
                    }
                }
                // Accommodation may be stored under either key; emit one row
                // for whichever wins.
                const accommodation = budget.bnb || budget.accommodation;
                if (accommodation && parseFloat(accommodation.totalCost || '0') > 0) {
                    generatedItems.push({
                        description: 'Overnight Accommodation',
                        amount: parseFloat(accommodation.totalCost).toFixed(2),
                        quantity: '1',
                        chargeTo,
                    });
                }
                // Tollgates is an array of entries, each with its own totalCost.
                if (Array.isArray(budget.tollgates)) {
                    for (const t of budget.tollgates) {
                        const total = parseFloat(String(t?.totalCost ?? '0')) || 0;
                        if (total > 0) {
                            generatedItems.push({
                                description: `Tollgate${t.road ? ` — ${t.road}` : ''}`,
                                amount: total.toFixed(2),
                                quantity: '1',
                                chargeTo,
                            });
                        }
                    }
                }
                // "Other" carries a custom description from the travel-auth form.
                if (budget.other && parseFloat(budget.other.totalCost || '0') > 0) {
                    generatedItems.push({
                        description: budget.other.description || 'Other',
                        amount: parseFloat(budget.other.totalCost).toFixed(2),
                        quantity: '1',
                        chargeTo,
                    });
                }

                if (generatedItems.length > 0) {
                    setLineItems(generatedItems);
                } else if (chargeTo) {
                    // Fall back to seeding the chargeTo on the first row when
                    // there's no budget detail to expand into rows.
                    setLineItems(prev => prev.map((item, idx) =>
                        idx === 0 && !item.chargeTo ? { ...item, chargeTo } : item
                    ));
                }
            } catch (err) {
                console.error('Failed to fetch linked travel auth:', err);
            }
        };
        if (status === 'authenticated' && linkedTravelAuthId) {
            fetchLinkedTravelAuth();
        }
    }, [linkedTravelAuthId, status, isEditMode, user?.display_name, session?.user?.name]);

    // Lock line-item editing when the rows were sourced from a fully-approved
    // travel-auth. The HRD's allocation and the approved totals are the
    // source of truth — letting the requester change them would invalidate
    // the original approval chain. Edit-mode (drafts) and approver edits
    // remain unlocked.
    const lineItemsLocked = !!linkedTravelAuth?.id && !isEditMode && !isApproverEditing;

    // Default the receiver to the requester's name once their profile loads (new requests only).
    useEffect(() => {
        if (!isEditMode && !formData.receivedBy && (user?.display_name || session?.user?.name)) {
            setFormData(prev => ({ ...prev, receivedBy: user?.display_name || session?.user?.name || '' }));
        }
    }, [isEditMode, formData.receivedBy, user?.display_name, session?.user?.name]);

    // Fetch users for approver / watcher selection.
    useEffect(() => {
        const fetchUsers = async () => {
            try {
                const response = await fetch('/api/users');
                if (response.ok) {
                    const data = await response.json();
                    setUsers(data.users || []);
                }
            } catch (err) {
                console.error('Failed to fetch users:', err);
            } finally {
                setLoadingUsers(false);
            }
        };
        if (status === 'authenticated') fetchUsers();
    }, [status]);

    // Auto-resolve approvers from HRIMS organogram for new requests.
    useEffect(() => {
        const resolveApprovers = async () => {
            if (!session?.user?.email || isEditMode) { setLoadingApproverResolution(false); return; }
            setLoadingApproverResolution(true);
            try {
                const response = await fetch(`/api/hrims/resolve-approvers?email=${encodeURIComponent(session.user.email)}&formType=petty-cash`);
                const data = await response.json();
                if (response.ok && data.approvers) {
                    const resolved: Record<string, boolean> = {};
                    const newApprovers: Record<string, string> = {};
                    for (const [roleKey, approver] of Object.entries(data.approvers)) {
                        if (approver && (approver as any).userId) {
                            newApprovers[roleKey] = (approver as any).userId;
                            resolved[roleKey] = true;
                        }
                    }
                    if (Object.keys(newApprovers).length > 0) {
                        setSelectedApprovers(prev => ({ ...prev, ...newApprovers }));
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
    }, [status, session?.user?.email, isEditMode]);

    const getFilteredUsersForRole = (roleKey: string) => {
        const term = approverSearch[roleKey] || '';
        const alreadySelectedIds = Object.values(selectedApprovers).filter(Boolean);
        // The requester can never approve their own request — hide themselves from the picker.
        const currentUserId = (session?.user as any)?.id;
        return users.filter(u => u.id !== currentUserId).filter(u => {
            const matches = term
                ? (u.display_name?.toLowerCase().includes(term.toLowerCase()) || u.email?.toLowerCase().includes(term.toLowerCase()))
                : true;
            const notTaken = !alreadySelectedIds.includes(u.id) || selectedApprovers[roleKey] === u.id;
            return matches && notTaken;
        });
    };

    const handleSelectApprover = (roleKey: string, userId: string) => {
        setSelectedApprovers(prev => ({ ...prev, [roleKey]: userId }));
        setApproverSearch(prev => ({ ...prev, [roleKey]: '' }));
        setShowApproverDropdown(null);
    };

    const handleRemoveApprover = (roleKey: string) => {
        setSelectedApprovers(prev => ({ ...prev, [roleKey]: '' }));
    };

    const getFilteredUsersForWatchers = () => {
        const taken = [
            ...selectedWatchers.map(w => w.id),
            ...Object.values(selectedApprovers).filter(Boolean),
            user?.id,
        ];
        return users.filter(u => {
            const matches = watcherSearch
                ? (u.display_name?.toLowerCase().includes(watcherSearch.toLowerCase()) || u.email?.toLowerCase().includes(watcherSearch.toLowerCase()))
                : true;
            return matches && !taken.includes(u.id);
        });
    };

    const handleSelectWatcher = (userId: string) => {
        const u = users.find(x => x.id === userId);
        if (u && !selectedWatchers.some(w => w.id === userId)) {
            setSelectedWatchers(prev => [...prev, { id: u.id, display_name: u.display_name, email: u.email }]);
        }
        setWatcherSearch('');
        setShowWatcherDropdown(false);
    };

    const handleRemoveWatcher = (userId: string) => {
        setSelectedWatchers(prev => prev.filter(w => w.id !== userId));
    };

    // Debounced reference-code lookup. Calls /api/requests/lookup-by-reference
    // and surfaces approved requests the user can attach to this petty cash.
    useEffect(() => {
        const trimmed = linkSearch.trim();
        if (trimmed.length < 2) {
            setLinkSearchResults([]);
            setLinkSearchError(null);
            return;
        }
        const handle = setTimeout(async () => {
            setLinkSearchLoading(true);
            setLinkSearchError(null);
            try {
                const res = await fetch(`/api/requests/lookup-by-reference?code=${encodeURIComponent(trimmed)}`);
                if (!res.ok) {
                    const data = await res.json().catch(() => ({}));
                    throw new Error(data.error || 'Lookup failed');
                }
                const data = await res.json();
                const alreadyLinked = new Set(linkedApprovedRequests.map(l => l.id));
                setLinkSearchResults((data.requests || []).filter((r: LinkedApprovedRequest) => !alreadyLinked.has(r.id)));
            } catch (err: any) {
                setLinkSearchError(err.message || 'Failed to search for approved requests');
                setLinkSearchResults([]);
            } finally {
                setLinkSearchLoading(false);
            }
        }, 250);
        return () => clearTimeout(handle);
    }, [linkSearch, linkedApprovedRequests]);

    const handleAddLinkedRequest = (linked: LinkedApprovedRequest) => {
        setLinkedApprovedRequests(prev => prev.some(l => l.id === linked.id) ? prev : [...prev, linked]);
        setLinkSearch('');
        setLinkSearchResults([]);
        setIsDirty(true);
    };

    const handleRemoveLinkedRequest = (id: string) => {
        setLinkedApprovedRequests(prev => prev.filter(l => l.id !== id));
        setIsDirty(true);
    };

    // Line item helpers.
    const addLineItem = () => setLineItems(prev => [...prev, emptyLineItem()]);
    const removeLineItem = (index: number) => {
        if (lineItems.length > 1) setLineItems(prev => prev.filter((_, i) => i !== index));
    };
    const updateLineItem = (index: number, field: keyof PettyCashLineItem, value: string) => {
        setLineItems(prev => prev.map((row, i) => i === index ? { ...row, [field]: value } : row));
    };

    const calculateTotal = (): string => {
        const total = lineItems.reduce((sum, row) => sum + lineItemTotal(row), 0);
        return total.toFixed(2);
    };

    // Document upload helpers.
    const handleSupportingDocUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = e.target.files;
        if (files) {
            const newDocs: SupportingDocument[] = Array.from(files).map(file => ({ file, label: '', description: '' }));
            setSupportingDocuments(prev => [...prev, ...newDocs]);
        }
    };
    const handleRemoveSupportingDoc = (index: number) => {
        setSupportingDocuments(prev => prev.filter((_, i) => i !== index));
    };
    const handleUpdateSupportingDoc = (index: number, field: keyof SupportingDocument, value: string) => {
        setSupportingDocuments(prev => prev.map((doc, i) => i === index ? { ...doc, [field]: value } : doc));
    };

    const getApproverName = (id: string) => users.find(u => u.id === id)?.display_name || id || 'None';

    // Build the metadata payload — single source of truth shared by submit / draft / approver-save.
    const buildMetadataPayload = () => ({
        type: 'petty_cash',
        requestType: 'petty_cash',
        // Prefer the linked travel-auth reference so a trip carries ONE
        // shared reference across the travel authorization and its petty cash.
        referenceCode: existingReferenceCode || linkedTravelAuth?.referenceCode || referenceCode || undefined,
        receiptDate: formData.receiptDate,
        purpose: formData.purpose,
        lineItems,
        totalAmount: calculateTotal(),
        currency: 'USD',
        receivedBy: {
            name: formData.receivedBy,
            date: formData.receivedDate,
            isExternal: formData.isExternalRecipient,
            externalIdNumber: formData.isExternalRecipient ? formData.externalIdNumber : undefined,
            signature: formData.isExternalRecipient ? recipientSignature : undefined,
        },
        linkedTravelAuthId: linkedTravelAuth?.id || linkedTravelAuthId || undefined,
        linkedTravelAuth: linkedTravelAuth || undefined,
        // Free-form links to other fully-approved in-system requests the
        // user picked by reference number. Persisted on the petty cash and
        // back-linked to each parent via /api/requests/[id]/link-petty-cash
        // on submit.
        linkedApprovedRequests: linkedApprovedRequests.length > 0 ? linkedApprovedRequests : undefined,
        approvers: [
            selectedApprovers.department_head,
            selectedApprovers.accountant,
            selectedApprovers.finance_manager,
        ].filter(Boolean),
        approverRoles: selectedApprovers,
        useParallelApprovals: false,
        onBehalfOf: onBehalfOf || null,
        watchers: selectedWatchers,
        supportingDocuments: [
            ...(Array.isArray(existingSupportingDocs) ? existingSupportingDocs : []),
            ...supportingDocuments.map(doc => ({
                name: doc.file.name,
                size: doc.file.size,
                type: doc.file.type,
                label: doc.label,
                description: doc.description,
                uploadedBy: {
                    id: user?.id || session?.user?.id,
                    name: user?.display_name || session?.user?.name || 'Unknown',
                    isApprover: isApproverEditing,
                },
                uploadedAt: new Date().toISOString(),
            })),
        ],
    });

    // Field-change collector for approver-edit tracking.
    const collectFieldChanges = () => {
        if (!originalFormData) return [];
        const changes: { fieldName: string; oldValue: any; newValue: any }[] = [];

        const compareScalars: Array<keyof typeof formData> = [
            'receiptDate', 'receivedBy', 'receivedDate',
            'isExternalRecipient', 'externalIdNumber', 'purpose',
        ];
        for (const f of compareScalars) {
            if (formData[f] !== originalFormData[f]) {
                changes.push({ fieldName: String(f), oldValue: originalFormData[f], newValue: formData[f] });
            }
        }
        if (originalLineItems && JSON.stringify(lineItems) !== JSON.stringify(originalLineItems)) {
            changes.push({ fieldName: 'lineItems', oldValue: JSON.stringify(originalLineItems), newValue: JSON.stringify(lineItems) });
        }
        if (originalApprovers) {
            const labels: Record<string, string> = {
                department_head: 'Department Head Approver',
                accountant: 'Accountant Approver',
                finance_manager: 'Finance Manager Approver',
            };
            for (const role of Object.keys(labels)) {
                const oldA = originalApprovers[role] || '';
                const newA = selectedApprovers[role] || '';
                if (oldA !== newA) {
                    changes.push({ fieldName: labels[role], oldValue: getApproverName(oldA), newValue: getApproverName(newA) });
                }
            }
        }
        return changes;
    };

    const validate = (): string[] => {
        const errors: string[] = [];

        if (!formData.purpose.trim()) errors.push('Purpose / Receipt of petty cash for is required');
        if (!formData.receivedBy.trim()) errors.push('Received by name is required');
        if (!formData.receivedDate) errors.push('Received date is required');
        if (formData.isExternalRecipient) {
            if (!formData.externalIdNumber.trim()) errors.push('ID Number is required for non-RTG recipients');
            if (!recipientSignature.data) errors.push('Recipient signature is required for non-RTG recipients');
        }

        const validRows = lineItems.filter(row => row.description.trim() || row.amount.trim() || row.chargeTo);
        if (validRows.length === 0) errors.push('At least one line item is required');
        for (const [i, row] of validRows.entries()) {
            const num = i + 1;
            if (!row.description.trim()) errors.push(`Line ${num}: description is required`);
            if (!row.amount || parseFloat(row.amount) <= 0) errors.push(`Line ${num}: amount must be greater than zero`);
            if (!row.quantity || parseFloat(row.quantity) <= 0) errors.push(`Line ${num}: quantity must be greater than zero`);
            if (!row.chargeTo) errors.push(`Line ${num}: charge to is required`);
        }

        if (!selectedApprovers.department_head) errors.push('Please select a Department Head approver');
        if (!selectedApprovers.accountant) errors.push('Please select an Accountant approver');
        if (!selectedApprovers.finance_manager) errors.push('Please select a Finance Manager approver');

        return errors;
    };

    const uploadDocuments = async (requestId: string) => {
        if (supportingDocuments.length === 0) return;
        const endpoint = isApproverEditing
            ? `/api/requests/${requestId}/approver-documents`
            : `/api/requests/${requestId}/documents`;
        for (const doc of supportingDocuments) {
            const fd = new FormData();
            fd.append('file', doc.file);
            fd.append('documentType', 'supporting');
            try {
                await fetch(endpoint, { method: 'POST', body: fd });
            } catch (uploadErr) {
                console.error('Error uploading document:', uploadErr);
            }
        }
    };

    // Approver-edit save (tracked).
    const handleApproverSave = async () => {
        setLoading(true);
        setError(null);
        try {
            const fieldChanges = collectFieldChanges();
            const response = await fetch(`/api/requests/${editRequestId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title: `Petty Cash: ${formData.purpose.substring(0, 50) || 'Request'}`,
                    description: formData.purpose,
                    metadata: buildMetadataPayload(),
                }),
            });
            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || 'Failed to save changes');
            }
            if (fieldChanges.length > 0) {
                await fetch(`/api/requests/${editRequestId}/approver-edit`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ fieldChanges }),
                });
            }
            await uploadDocuments(editRequestId as string);
            router.push(`/requests/${editRequestId}`);
        } catch (err: any) {
            setError(err.message || 'Failed to save changes');
        } finally {
            setLoading(false);
        }
    };

    // Draft owner save (edit mode, untracked).
    const handleDraftSaveExisting = async () => {
        setSavingDraft(true);
        setError(null);
        try {
            const response = await fetch(`/api/requests/${editRequestId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title: `Petty Cash: ${formData.purpose.substring(0, 50) || 'Draft'}`,
                    description: formData.purpose || 'Draft request',
                    metadata: buildMetadataPayload(),
                }),
            });
            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || 'Failed to save draft');
            }
            await uploadDocuments(editRequestId as string);
            router.push(`/requests/${editRequestId}`);
        } catch (err: any) {
            setError(err.message || 'Failed to save draft');
        } finally {
            setSavingDraft(false);
        }
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (isApproverEditing && isEditMode) { await handleApproverSave(); return; }
        if (isEditMode && !isApproverEditing) { await handleDraftSaveExisting(); return; }
        setShowConfirm(true);
    };

    const performSubmit = async () => {
        setLoading(true);
        setError(null);

        const errors = validate();
        if (errors.length > 0) {
            setError(errors.join('. '));
            setLoading(false);
            return;
        }

        try {
            const response = await fetch('/api/requests', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title: `Petty Cash: ${formData.purpose.substring(0, 50)}`,
                    description: formData.purpose,
                    priority: 'normal',
                    category: 'finance',
                    requestType: 'petty_cash',
                    status: 'pending',
                    metadata: buildMetadataPayload(),
                }),
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Failed to create petty cash request');

            const requestId = data.request.id;
            await uploadDocuments(requestId);

            // If we came from a travel-auth, write a back-reference into its metadata
            // so the originating request page can show the linked petty cash voucher.
            if (linkedTravelAuth?.id) {
                try {
                    await fetch(`/api/requests/${linkedTravelAuth.id}/link-petty-cash`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ pettyCashRequestId: requestId }),
                    });
                } catch (linkErr) {
                    // Best-effort — the petty cash request itself stores the link too.
                    console.error('Failed to back-link travel auth:', linkErr);
                }
            }

            // Back-link any other approved requests the user attached by
            // reference number. The endpoint silently rejects requests the
            // current user doesn't own — that's fine, the petty cash still
            // stores the forward link.
            for (const linked of linkedApprovedRequests) {
                if (linked.id === linkedTravelAuth?.id) continue;
                try {
                    await fetch(`/api/requests/${linked.id}/link-petty-cash`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ pettyCashRequestId: requestId }),
                    });
                } catch (linkErr) {
                    console.error(`Failed to back-link ${linked.referenceCode || linked.id}:`, linkErr);
                }
            }

            router.push(`/requests/${requestId}`);
        } catch (err: any) {
            setError(err.message || 'Failed to create petty cash request');
        } finally {
            setLoading(false);
        }
    };

    const handleSaveDraft = async () => {
        setSavingDraft(true);
        setError(null);
        try {
            const response = await fetch('/api/requests', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title: `Petty Cash: ${formData.purpose.substring(0, 50) || 'Draft'}`,
                    description: formData.purpose || 'Draft request',
                    priority: 'normal',
                    category: 'finance',
                    requestType: 'petty_cash',
                    status: 'draft',
                    metadata: buildMetadataPayload(),
                }),
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Failed to save draft');

            const requestId = data.request.id;
            await uploadDocuments(requestId);
            router.push(`/requests/${requestId}`);
        } catch (err: any) {
            setError(err.message || 'Failed to save draft');
        } finally {
            setSavingDraft(false);
        }
    };

    const buildPreviewSections = (): PreviewSection[] => [
        {
            title: 'Receipt Details',
            fields: [
                { label: 'Receipt Date', value: formData.receiptDate || '—' },
                { label: 'Purpose', value: formData.purpose || '—', fullWidth: true },
                { label: 'Total Amount (USD)', value: `$${calculateTotal()}` },
                { label: 'Linked Travel Auth', value: linkedTravelAuth?.referenceCode || linkedTravelAuth?.title || (linkedTravelAuth?.id ? '—' : 'None') },
            ],
        },
        {
            title: 'Line Items',
            content: (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead>
                        <tr>
                            <th style={{ border: '1px solid #333', padding: '6px 8px', background: '#F3EADC', textAlign: 'left' }}>Item (Describe FULLY)</th>
                            <th style={{ border: '1px solid #333', padding: '6px 8px', background: '#F3EADC', textAlign: 'right', width: '13%' }}>Amount (USD)</th>
                            <th style={{ border: '1px solid #333', padding: '6px 8px', background: '#F3EADC', textAlign: 'right', width: '10%' }}>Qty</th>
                            <th style={{ border: '1px solid #333', padding: '6px 8px', background: '#F3EADC', textAlign: 'right', width: '13%' }}>Total (USD)</th>
                            <th style={{ border: '1px solid #333', padding: '6px 8px', background: '#F3EADC', textAlign: 'left', width: '22%' }}>Charge To</th>
                        </tr>
                    </thead>
                    <tbody>
                        {lineItems.filter(r => r.description || r.amount || r.chargeTo).map((row, i) => (
                            <tr key={i}>
                                <td style={{ border: '1px solid #333', padding: '6px 8px' }}>{row.description || '—'}</td>
                                <td style={{ border: '1px solid #333', padding: '6px 8px', textAlign: 'right' }}>{row.amount ? `$${parseFloat(row.amount).toFixed(2)}` : '—'}</td>
                                <td style={{ border: '1px solid #333', padding: '6px 8px', textAlign: 'right' }}>{row.quantity || '—'}</td>
                                <td style={{ border: '1px solid #333', padding: '6px 8px', textAlign: 'right' }}>${lineItemTotal(row).toFixed(2)}</td>
                                <td style={{ border: '1px solid #333', padding: '6px 8px' }}>{chargeToLabel(row.chargeTo)}</td>
                            </tr>
                        ))}
                        <tr>
                            <td style={{ border: '1px solid #333', padding: '6px 8px', fontWeight: 700, background: '#F3EADC' }} colSpan={3}>TOTAL</td>
                            <td style={{ border: '1px solid #333', padding: '6px 8px', fontWeight: 700, background: '#F3EADC', textAlign: 'right' }}>${calculateTotal()}</td>
                            <td style={{ border: '1px solid #333', padding: '6px 8px', background: '#F3EADC' }}></td>
                        </tr>
                    </tbody>
                </table>
            ),
        },
        {
            title: 'Recipient',
            fields: [
                { label: 'Received by', value: formData.receivedBy || '—' },
                { label: 'Date', value: formData.receivedDate || '—' },
                { label: 'Amount $', value: `$${calculateTotal()}` },
                { label: 'External Recipient', value: formData.isExternalRecipient ? 'Yes' : 'No' },
                ...(formData.isExternalRecipient ? [
                    { label: 'ID No.', value: formData.externalIdNumber || '—' },
                    { label: 'Signature', value: recipientSignature.data ? 'Captured' : 'Missing' },
                ] : []),
            ],
        },
        {
            title: 'Approvers (Sequential)',
            fields: approvalRoles.map(r => ({
                label: r.label,
                value: users.find(u => u.id === selectedApprovers[r.key])?.display_name || 'Not selected',
            })),
        },
        ...(linkedApprovedRequests.length > 0 ? [{
            title: 'Linked Approved Requests',
            fields: linkedApprovedRequests.map(l => ({
                label: l.referenceCode || l.requestType,
                value: l.title,
            })),
        }] : []),
    ];

    const unsavedPrompt = useUnsavedChangesPrompt({
        isDirty,
        disabled: loading || savingDraft,
    });

    if (status === 'loading' || loadingRequest) {
        return (
            <AppLayout title="Petty Cash" showBack onBack={() => router.back()}>
                <div className="flex items-center justify-center min-h-[60vh]">
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-500" />
                </div>
            </AppLayout>
        );
    }

    if (!session) return null;

    const pageTitle = isApproverEditing
        ? 'Edit Petty Cash Request (Approver)'
        : isEditMode
            ? 'Edit Petty Cash Request'
            : 'Petty Cash Request';

    return (
        <AppLayout title={pageTitle} showBack onBack={() => router.back()} hideNav>
            <form onSubmit={handleSubmit} onChange={() => setIsDirty(true)} className="p-4 sm:p-6 max-w-5xl mx-auto pb-32">
                <div className="mb-6 text-center">
                    <h1 className="text-2xl font-bold text-text-primary font-heading uppercase tracking-wide">
                        {isApproverEditing ? 'Edit Petty Cash Request' : 'Receipt of Petty Cash'}
                    </h1>
                    <p className="text-sm text-gray-500 mt-1">DOC NO: FIN APX – PETTY CASH VOUCHER</p>
                    <div className="mt-4 max-w-lg mx-auto">
                        {/* When this voucher is linked to a fully-approved travel auth, inherit
                            its reference code so the trip has ONE shared identifier across both
                            documents. Otherwise generate a fresh petty-cash reference. */}
                        <ReferenceCodeBanner
                            requestType="petty_cash"
                            existingCode={existingReferenceCode || linkedTravelAuth?.referenceCode || null}
                            onCodeAssigned={setReferenceCode}
                            label={linkedTravelAuth?.referenceCode ? 'Trip Reference (linked)' : 'Request Reference'}
                        />
                    </div>
                    {isApproverEditing && (
                        <div className="mt-3 inline-flex items-center gap-2 px-4 py-2 bg-primary-50 border border-primary-200 rounded-xl">
                            <svg className="w-4 h-4 text-primary-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                            </svg>
                            <span className="text-sm font-medium text-primary-700">Editing as Approver — Changes will be tracked</span>
                        </div>
                    )}
                </div>

                {error && (
                    <Card className="mb-4 bg-danger-50 border-danger-200">
                        <p className="text-danger-600 text-sm">{error}</p>
                    </Card>
                )}

                <div className="space-y-6">
                    {/* Filing on behalf of — shown at the top; only assigned assistants see it */}
                    <Card className="p-6">
                        <OnBehalfOfField value={onBehalfOf} onChange={setOnBehalfOf} />
                    </Card>

                    {/* Linked Travel Auth banner */}
                    {linkedTravelAuth && (
                        <Card className="p-5 bg-emerald-50 border-emerald-200">
                            <div className="flex items-start gap-3">
                                <svg className="w-5 h-5 text-emerald-600 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                                </svg>
                                <div className="flex-1 min-w-0">
                                    <h3 className="font-semibold text-emerald-900">Linked Travel Authorization</h3>
                                    <p className="text-sm text-emerald-800 mt-1">
                                        This petty cash voucher is linked to{' '}
                                        <a href={`/requests/${linkedTravelAuth.id}`} className="font-mono font-bold underline hover:text-emerald-700" target="_blank" rel="noopener noreferrer">
                                            {linkedTravelAuth.referenceCode || linkedTravelAuth.title}
                                        </a>
                                        {linkedTravelAuth.purposeOfTravel ? ` — ${linkedTravelAuth.purposeOfTravel}` : ''}
                                    </p>
                                </div>
                            </div>
                        </Card>
                    )}

                    {/* Requestor Information */}
                    <Card className="p-6">
                        <h3 className="text-sm font-semibold text-gray-700 mb-4 uppercase border-b pb-2">Requestor Information</h3>
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                            <div>
                                <label className="block text-sm font-semibold text-gray-700 mb-1 uppercase">Name</label>
                                <div className="px-4 py-2 rounded-xl border border-gray-200 bg-gray-50 text-gray-600">
                                    {user?.display_name || session?.user?.name || 'N/A'}
                                </div>
                            </div>
                            <div>
                                <label className="block text-sm font-semibold text-gray-700 mb-1 uppercase">Business Unit</label>
                                <div className="px-4 py-2 rounded-xl border border-gray-200 bg-gray-50 text-gray-600">
                                    {businessUnitName || 'N/A'}
                                </div>
                            </div>
                            <div>
                                <label className="block text-sm font-semibold text-gray-700 mb-1 uppercase">Department</label>
                                <div className="px-4 py-2 rounded-xl border border-gray-200 bg-gray-50 text-gray-600">
                                    {departmentName || 'N/A'}
                                </div>
                            </div>
                            <div>
                                <label className="block text-sm font-semibold text-gray-700 mb-1 uppercase">Date</label>
                                <div className="px-4 py-2 rounded-xl border border-gray-200 bg-gray-50 text-gray-600">
                                    {today}
                                </div>
                            </div>
                        </div>
                    </Card>

                    {/* Receipt of Petty Cash for */}
                    <Card className="p-6">
                        <label className="block text-sm font-semibold text-gray-700 mb-1 uppercase">
                            Receipt of Petty Cash for <span className="text-danger-500">*</span>
                        </label>
                        <textarea
                            className="w-full px-4 py-3 rounded-xl border border-gray-300 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none transition-all resize-none min-h-[80px]"
                            value={formData.purpose}
                            onChange={(e) => setFormData({ ...formData, purpose: e.target.value })}
                            placeholder="Describe what this petty cash is for"
                            required
                        />
                        <div className="mt-4">
                            <label className="block text-sm font-semibold text-gray-700 mb-1 uppercase">Date</label>
                            {/* Auto-generated and locked — the receipt date is always the
                                day the voucher is raised and cannot be back- or forward-dated. */}
                            <div className="px-4 py-2 rounded-xl border border-gray-200 bg-gray-50 text-gray-600">
                                {formData.receiptDate
                                    ? new Date(formData.receiptDate).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' })
                                    : today}
                            </div>
                        </div>
                    </Card>

                    {/* Line Items */}
                    <Card className="p-6">
                        <div className="flex items-center justify-between mb-4 border-b pb-2">
                            <h3 className="text-sm font-semibold text-gray-700 uppercase">
                                Line Items <span className="text-danger-500">*</span>
                                {lineItemsLocked && (
                                    <span className="ml-2 inline-flex items-center gap-1 text-[10px] font-medium text-amber-700 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded uppercase tracking-wide">
                                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                                        </svg>
                                        Locked from travel auth
                                    </span>
                                )}
                            </h3>
                            {!lineItemsLocked && (
                                <button
                                    type="button"
                                    onClick={addLineItem}
                                    className="inline-flex items-center gap-1 text-sm font-medium text-primary-600 hover:text-primary-700"
                                >
                                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4v16m8-8H4" />
                                    </svg>
                                    Add Line
                                </button>
                            )}
                        </div>
                        {lineItemsLocked && (
                            <p className="text-xs text-gray-500 mb-3">
                                Line items, amounts and cost allocation were carried over from the approved travel
                                authorisation and the Chief Human Capital Officer&apos;s cost allocation. They can&apos;t be changed here.
                            </p>
                        )}
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="bg-gray-50 border-b">
                                        <th className="px-3 py-2 text-left text-xs font-semibold text-gray-700 uppercase">Items (Describe FULLY)</th>
                                        <th className="px-3 py-2 text-right text-xs font-semibold text-gray-700 uppercase w-28">Amount (USD)</th>
                                        <th className="px-3 py-2 text-right text-xs font-semibold text-gray-700 uppercase w-24">Quantity</th>
                                        <th className="px-3 py-2 text-right text-xs font-semibold text-gray-700 uppercase w-28">Total (USD)</th>
                                        <th className="px-3 py-2 text-left text-xs font-semibold text-gray-700 uppercase w-56">Charge To</th>
                                        <th className="px-3 py-2 w-10"></th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {lineItems.map((row, idx) => (
                                        <tr key={idx} className={`border-b border-gray-100 ${lineItemsLocked ? 'bg-amber-50/30' : ''}`}>
                                            <td className="px-2 py-2">
                                                <input
                                                    type="text"
                                                    value={row.description}
                                                    onChange={(e) => updateLineItem(idx, 'description', e.target.value)}
                                                    placeholder="Describe the item"
                                                    readOnly={lineItemsLocked}
                                                    required={!lineItemsLocked}
                                                    className={`w-full px-2 py-1 rounded border border-gray-300 focus:ring-1 focus:ring-primary-500 outline-none text-sm ${lineItemsLocked ? 'bg-gray-100 cursor-not-allowed' : ''}`}
                                                />
                                            </td>
                                            <td className="px-2 py-2">
                                                <input
                                                    type="number"
                                                    step="0.01"
                                                    min="0.01"
                                                    value={row.amount}
                                                    onChange={(e) => updateLineItem(idx, 'amount', e.target.value)}
                                                    placeholder="0.00"
                                                    readOnly={lineItemsLocked}
                                                    required={!lineItemsLocked}
                                                    className={`w-full px-2 py-1 rounded border border-gray-300 focus:ring-1 focus:ring-primary-500 outline-none text-sm text-right ${lineItemsLocked ? 'bg-gray-100 cursor-not-allowed' : ''}`}
                                                />
                                            </td>
                                            <td className="px-2 py-2">
                                                <input
                                                    type="number"
                                                    step="1"
                                                    min="1"
                                                    value={row.quantity}
                                                    onChange={(e) => updateLineItem(idx, 'quantity', e.target.value)}
                                                    placeholder="1"
                                                    readOnly={lineItemsLocked}
                                                    required={!lineItemsLocked}
                                                    className={`w-full px-2 py-1 rounded border border-gray-300 focus:ring-1 focus:ring-primary-500 outline-none text-sm text-right ${lineItemsLocked ? 'bg-gray-100 cursor-not-allowed' : ''}`}
                                                />
                                            </td>
                                            <td className="px-2 py-2 text-right text-sm font-medium text-gray-800 whitespace-nowrap">
                                                ${lineItemTotal(row).toFixed(2)}
                                            </td>
                                            <td className="px-2 py-2">
                                                <select
                                                    value={row.chargeTo}
                                                    onChange={(e) => updateLineItem(idx, 'chargeTo', e.target.value)}
                                                    disabled={lineItemsLocked}
                                                    className={`w-full px-2 py-1 rounded border border-gray-300 focus:ring-1 focus:ring-primary-500 outline-none text-sm ${lineItemsLocked ? 'bg-gray-100 cursor-not-allowed' : 'bg-white'}`}
                                                >
                                                    <option value="">Select department...</option>
                                                    {chargeToOptions.map(o => (
                                                        <option key={o.value} value={o.value}>{o.label}</option>
                                                    ))}
                                                </select>
                                            </td>
                                            <td className="px-2 py-2 text-center">
                                                <button
                                                    type="button"
                                                    onClick={() => removeLineItem(idx)}
                                                    disabled={lineItems.length === 1 || lineItemsLocked}
                                                    className="text-gray-400 hover:text-danger-500 disabled:opacity-30 disabled:cursor-not-allowed"
                                                    title={lineItemsLocked ? 'Locked from travel auth' : (lineItems.length === 1 ? 'At least one line is required' : 'Remove line')}
                                                >
                                                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" />
                                                    </svg>
                                                </button>
                                            </td>
                                        </tr>
                                    ))}
                                    <tr className="bg-gray-100 font-semibold">
                                        <td className="px-3 py-2 text-gray-900 text-right" colSpan={3}>TOTAL</td>
                                        <td className="px-3 py-2 text-gray-900 text-right whitespace-nowrap">USD ${calculateTotal()}</td>
                                        <td colSpan={2}></td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>
                    </Card>

                    {/* Recipient */}
                    <Card className="p-6">
                        <h3 className="text-sm font-semibold text-gray-700 mb-4 uppercase border-b pb-2">Recipient</h3>
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                            <div>
                                <label className="block text-sm font-semibold text-gray-700 mb-1 uppercase">Received by <span className="text-danger-500">*</span></label>
                                <input
                                    type="text"
                                    className="w-full px-4 py-2 rounded-xl border border-gray-300 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none"
                                    value={formData.receivedBy}
                                    onChange={(e) => setFormData({ ...formData, receivedBy: e.target.value })}
                                    placeholder="Full name of recipient"
                                    required
                                />
                            </div>
                            <Input
                                type="date"
                                label="Date *"
                                value={formData.receivedDate}
                                onChange={(e) => setFormData({ ...formData, receivedDate: e.target.value })}
                                required
                            />
                            <div>
                                <label className="block text-sm font-semibold text-gray-700 mb-1 uppercase">Amount $</label>
                                <div className="px-4 py-2 rounded-xl border border-gray-200 bg-gray-50 text-gray-700 font-semibold">
                                    USD ${calculateTotal()}
                                </div>
                            </div>
                        </div>

                        <div className="mt-6 p-4 rounded-xl bg-gray-50 border border-gray-200">
                            <div className="flex items-start gap-3">
                                <input
                                    type="checkbox"
                                    id="isExternalRecipient"
                                    checked={formData.isExternalRecipient}
                                    onChange={(e) => setFormData({ ...formData, isExternalRecipient: e.target.checked })}
                                    className="mt-1 w-5 h-5 text-primary-600 focus:ring-primary-500 border-gray-300 rounded cursor-pointer"
                                />
                                <label htmlFor="isExternalRecipient" className="cursor-pointer">
                                    <span className="font-semibold text-gray-900 block">If Not RTG Associated</span>
                                    <span className="text-sm text-gray-500 mt-1 block">
                                        Tick this if the recipient is not an RTG employee. They must provide an ID number and signature.
                                    </span>
                                </label>
                            </div>

                            {formData.isExternalRecipient && (
                                <div className="mt-4 pt-4 border-t border-gray-200 space-y-4">
                                    <Input
                                        label="ID No. *"
                                        value={formData.externalIdNumber}
                                        onChange={(e) => setFormData({ ...formData, externalIdNumber: e.target.value })}
                                        placeholder="National ID / Passport number"
                                        required
                                    />
                                    <div>
                                        <label className="block text-sm font-semibold text-gray-700 mb-2 uppercase">Recipient Signature <span className="text-danger-500">*</span></label>
                                        <SignatureSelector
                                            savedSignatureUrl={null}
                                            userDisplayName={formData.receivedBy}
                                            value={recipientSignature}
                                            onChange={(sel) => { setRecipientSignature(sel); setIsDirty(true); }}
                                        />
                                    </div>
                                </div>
                            )}
                        </div>
                    </Card>

                    {/* Supporting Documents */}
                    <Card className="p-6">
                        <div className="flex justify-between items-center mb-4 border-b pb-2">
                            <h3 className="text-sm font-semibold text-gray-700 uppercase">Supporting Documents (Optional)</h3>
                            <div>
                                <input
                                    type="file"
                                    id="petty-cash-supporting-docs"
                                    className="hidden"
                                    multiple
                                    onChange={handleSupportingDocUpload}
                                />
                                <label
                                    htmlFor="petty-cash-supporting-docs"
                                    className="inline-flex items-center gap-1 text-sm font-medium text-primary-600 hover:text-primary-700 cursor-pointer"
                                >
                                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4v16m8-8H4" />
                                    </svg>
                                    Add File
                                </label>
                            </div>
                        </div>

                        {existingSupportingDocs.length === 0 && supportingDocuments.length === 0 ? (
                            <p className="text-sm text-gray-500">No supporting documents uploaded.</p>
                        ) : (
                            <div className="space-y-3">
                                {existingSupportingDocs.map((doc, i) => (
                                    <div key={`existing-${i}`} className="flex items-center justify-between gap-3 p-3 rounded-lg border border-gray-200 bg-gray-50">
                                        <div className="flex items-center gap-3 min-w-0">
                                            <svg className="w-5 h-5 text-gray-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                                            </svg>
                                            <span className="text-sm text-gray-700 truncate">{doc.name || doc.label}</span>
                                        </div>
                                        <span className="text-xs text-gray-400 flex-shrink-0">Existing</span>
                                    </div>
                                ))}
                                {supportingDocuments.map((doc, i) => (
                                    <div key={`new-${i}`} className="p-3 rounded-lg border border-gray-200 space-y-2">
                                        <div className="flex items-center justify-between gap-3">
                                            <span className="text-sm text-gray-700 truncate">{doc.file.name}</span>
                                            <button
                                                type="button"
                                                onClick={() => handleRemoveSupportingDoc(i)}
                                                className="text-gray-400 hover:text-danger-500"
                                            >
                                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" />
                                                </svg>
                                            </button>
                                        </div>
                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                                            <input
                                                type="text"
                                                placeholder="Label (e.g. Receipt)"
                                                value={doc.label}
                                                onChange={(e) => handleUpdateSupportingDoc(i, 'label', e.target.value)}
                                                className="px-3 py-1.5 text-sm rounded-lg border border-gray-300 focus:ring-1 focus:ring-primary-500 outline-none"
                                            />
                                            <input
                                                type="text"
                                                placeholder="Description"
                                                value={doc.description}
                                                onChange={(e) => handleUpdateSupportingDoc(i, 'description', e.target.value)}
                                                className="px-3 py-1.5 text-sm rounded-lg border border-gray-300 focus:ring-1 focus:ring-primary-500 outline-none"
                                            />
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </Card>

                    {/* Linked Approved Requests */}
                    <Card className="p-6">
                        <div className="mb-4 border-b pb-2">
                            <h3 className="text-sm font-semibold text-gray-700 uppercase">Link to Approved Requests (Optional)</h3>
                            <p className="text-xs text-gray-500 mt-1">
                                Search by reference number to link this petty cash voucher to a fully-approved CAPEX, travel auth, or other in-system request.
                                Approvers will see the link on the voucher.
                            </p>
                        </div>

                        {linkedApprovedRequests.length > 0 && (
                            <div className="mb-4 space-y-2">
                                {linkedApprovedRequests.map(l => (
                                    <div key={l.id} className="flex items-center justify-between gap-3 p-3 rounded-lg bg-emerald-50 border border-emerald-200">
                                        <div className="min-w-0 flex-1">
                                            <div className="flex items-center gap-2 flex-wrap">
                                                <span className="font-mono text-xs font-bold text-emerald-800 bg-white border border-emerald-200 px-1.5 py-0.5 rounded">
                                                    {l.referenceCode || l.id.substring(0, 8)}
                                                </span>
                                                <span className="text-xs uppercase tracking-wide text-emerald-700">{l.requestType.replace(/_/g, ' ')}</span>
                                                {l.approvedAt && (
                                                    <span className="text-[10px] text-emerald-600">Approved {new Date(l.approvedAt).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' })}</span>
                                                )}
                                            </div>
                                            <p className="text-sm text-gray-800 truncate mt-0.5">{l.title}</p>
                                        </div>
                                        <button
                                            type="button"
                                            onClick={() => handleRemoveLinkedRequest(l.id)}
                                            className="text-gray-400 hover:text-danger-500 flex-shrink-0"
                                            title="Remove link"
                                        >
                                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" />
                                            </svg>
                                        </button>
                                    </div>
                                ))}
                            </div>
                        )}

                        <div className="relative">
                            <div className="relative">
                                <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                                </svg>
                                <input
                                    type="text"
                                    className="w-full pl-10 pr-4 py-2 rounded-xl border border-gray-300 bg-white focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none"
                                    placeholder="Enter reference code (e.g. TA-..., CAP-..., HB-...)"
                                    value={linkSearch}
                                    onChange={(e) => setLinkSearch(e.target.value)}
                                />
                            </div>
                            {(linkSearch.trim().length >= 2 || linkSearchLoading) && (
                                <div className="mt-2 border border-gray-200 rounded-xl bg-white shadow-sm max-h-64 overflow-y-auto">
                                    {linkSearchLoading ? (
                                        <div className="p-3 text-center text-gray-500 text-sm">Searching...</div>
                                    ) : linkSearchError ? (
                                        <div className="p-3 text-center text-danger-600 text-sm">{linkSearchError}</div>
                                    ) : linkSearchResults.length === 0 ? (
                                        <div className="p-3 text-center text-gray-500 text-sm">
                                            No approved request found with that reference. Only fully-approved requests can be linked.
                                        </div>
                                    ) : (
                                        linkSearchResults.map(r => (
                                            <button
                                                key={r.id}
                                                type="button"
                                                onClick={() => handleAddLinkedRequest(r)}
                                                className="w-full flex items-start gap-3 p-3 hover:bg-gray-50 transition-colors text-left border-b last:border-b-0"
                                            >
                                                <div className="min-w-0 flex-1">
                                                    <div className="flex items-center gap-2 flex-wrap">
                                                        <span className="font-mono text-xs font-bold text-gray-700 bg-gray-100 border border-gray-200 px-1.5 py-0.5 rounded">
                                                            {r.referenceCode || r.id.substring(0, 8)}
                                                        </span>
                                                        <span className="text-[10px] uppercase tracking-wide text-gray-500">{r.requestType.replace(/_/g, ' ')}</span>
                                                        <span className="text-[10px] text-emerald-700 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded">Approved</span>
                                                    </div>
                                                    <p className="text-sm text-gray-800 truncate mt-0.5">{r.title}</p>
                                                </div>
                                                <svg className="w-4 h-4 text-gray-400 flex-shrink-0 mt-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4v16m8-8H4" />
                                                </svg>
                                            </button>
                                        ))
                                    )}
                                </div>
                            )}
                        </div>
                    </Card>

                    {/* Watchers */}
                    <Card className="p-6">
                        <div className="mb-4 border-b pb-2">
                            <h3 className="text-sm font-semibold text-gray-700 uppercase">Watchers (Optional)</h3>
                            <p className="text-xs text-gray-500 mt-1">Add users who should be notified of this request.</p>
                        </div>
                        {selectedWatchers.length > 0 && (
                            <div className="mb-3 flex flex-wrap gap-2">
                                {selectedWatchers.map(w => (
                                    <span key={w.id} className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-primary-50 text-primary-700 text-sm border border-primary-200">
                                        {w.display_name}
                                        <button type="button" onClick={() => handleRemoveWatcher(w.id)} className="hover:text-primary-900">
                                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" /></svg>
                                        </button>
                                    </span>
                                ))}
                            </div>
                        )}
                        <div className="relative">
                            {showWatcherDropdown && <div className="fixed inset-0 z-10" onClick={() => setShowWatcherDropdown(false)} />}
                            <div className="relative">
                                <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
                                <input
                                    type="text"
                                    className="w-full pl-10 pr-4 py-2 rounded-xl border border-gray-300 bg-white focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none"
                                    placeholder="Search to add a watcher..."
                                    value={watcherSearch}
                                    onChange={(e) => { setWatcherSearch(e.target.value); setShowWatcherDropdown(true); }}
                                    onFocus={() => setShowWatcherDropdown(true)}
                                />
                            </div>
                            {showWatcherDropdown && (
                                <div className="absolute z-20 mt-1 w-full bg-white border border-gray-200 rounded-xl shadow-lg max-h-48 overflow-y-auto">
                                    {loadingUsers
                                        ? <div className="p-3 text-center text-gray-500 text-sm">Loading users...</div>
                                        : getFilteredUsersForWatchers().length === 0
                                            ? <div className="p-3 text-center text-gray-500 text-sm">No users found</div>
                                            : getFilteredUsersForWatchers().slice(0, 10).map(u => (
                                                <button
                                                    key={u.id}
                                                    type="button"
                                                    onClick={() => handleSelectWatcher(u.id)}
                                                    className="w-full flex items-center gap-3 p-3 hover:bg-gray-50 transition-colors text-left"
                                                >
                                                    <div className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center flex-shrink-0">
                                                        <span className="text-sm font-medium text-gray-600">{u.display_name?.charAt(0)?.toUpperCase() || '?'}</span>
                                                    </div>
                                                    <div className="flex-1 min-w-0">
                                                        <p className="text-sm font-medium text-gray-900 truncate">{u.display_name}</p>
                                                        <p className="text-xs text-gray-500 truncate">{u.email}</p>
                                                    </div>
                                                </button>
                                            ))}
                                </div>
                            )}
                        </div>
                    </Card>

                    {/* Approval Workflow */}
                    <Card className="p-6">
                        <h3 className="font-semibold text-text-primary mb-4 flex items-center gap-2 text-lg">
                            <svg className="w-5 h-5 text-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                            Approval Workflow <span className="text-danger-500">*</span>
                        </h3>
                        <p className="text-sm text-text-secondary mb-4">
                            Sequential approval: Department Head → Accountant → Finance Manager. Approvers are auto-assigned from HRIMS.
                        </p>

                        {loadingApproverResolution && <ApproverSectionLoader rows={approvalRoles.length} />}

                        {showApproverDropdown && <div className="fixed inset-0 z-10" onClick={() => setShowApproverDropdown(null)} />}

                        <div className={`space-y-4 ${loadingApproverResolution ? 'hidden' : ''}`}>
                            {approvalRoles.map((role, index) => {
                                const selectedUserId = selectedApprovers[role.key];
                                const selectedUser = selectedUserId ? users.find(u => u.id === selectedUserId) : null;
                                const filteredUsers = getFilteredUsersForRole(role.key);
                                const isAutoResolved = autoResolvedRoles[role.key];

                                return (
                                    <div key={role.key} className="relative">
                                        <div className="flex items-start gap-4">
                                            <div className="w-10 h-10 rounded-full flex items-center justify-center border-2 bg-primary-50 border-primary-200 text-primary-600 flex-shrink-0 mt-1">
                                                <span className="font-bold text-sm">{index + 1}</span>
                                            </div>
                                            <div className="flex-1">
                                                <div className="mb-2">
                                                    <h4 className="font-semibold text-gray-900">{role.label}</h4>
                                                    <p className="text-xs text-gray-500">{role.description}</p>
                                                </div>
                                                {selectedUser ? (
                                                    <div className={`flex items-center gap-3 ${isAutoResolved ? 'bg-green-50 border border-green-200' : 'bg-primary-50 border border-primary-200'} p-3 rounded-xl`}>
                                                        <div className={`w-8 h-8 rounded-full ${isAutoResolved ? 'bg-green-100' : 'bg-primary-100'} flex items-center justify-center flex-shrink-0`}>
                                                            <span className={`text-sm font-medium ${isAutoResolved ? 'text-green-600' : 'text-primary-600'}`}>{selectedUser.display_name?.charAt(0)?.toUpperCase() || '?'}</span>
                                                        </div>
                                                        <div className="flex-1 min-w-0">
                                                            <p className="text-sm font-medium text-gray-900 truncate">{selectedUser.display_name}</p>
                                                            <p className="text-xs text-gray-500 truncate">{selectedUser.email}</p>
                                                            {isAutoResolved && <p className="text-xs text-green-600 mt-0.5">Auto-assigned from HRIMS</p>}
                                                        </div>
                                                        <button
                                                            type="button"
                                                            onClick={() => { handleRemoveApprover(role.key); setAutoResolvedRoles(prev => ({ ...prev, [role.key]: false })); }}
                                                            className="p-1.5 rounded-lg hover:bg-danger-50 text-gray-400 hover:text-danger-500"
                                                            title="Change approver"
                                                        >
                                                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" /></svg>
                                                        </button>
                                                    </div>
                                                ) : (
                                                    <div className="relative">
                                                        {!loadingApproverResolution && !isEditMode && (
                                                            <p className="text-xs text-amber-600 mb-1">No user found in HRIMS for this role. Please select manually.</p>
                                                        )}
                                                        <div className="relative">
                                                            <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
                                                            <input
                                                                type="text"
                                                                className="w-full pl-10 pr-4 py-2 min-h-[44px] rounded-xl border border-gray-300 bg-white text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                                                                placeholder={`Search for ${role.label}...`}
                                                                value={approverSearch[role.key]}
                                                                onChange={(e) => { setApproverSearch(prev => ({ ...prev, [role.key]: e.target.value })); setShowApproverDropdown(role.key); }}
                                                                onFocus={() => setShowApproverDropdown(role.key)}
                                                            />
                                                        </div>
                                                        {showApproverDropdown === role.key && (
                                                            <div className="absolute z-20 mt-1 w-full bg-white border border-gray-200 rounded-xl shadow-lg max-h-48 overflow-y-auto">
                                                                {loadingUsers
                                                                    ? <div className="p-3 text-center text-gray-500 text-sm">Loading users...</div>
                                                                    : filteredUsers.length === 0
                                                                        ? <div className="p-3 text-center text-gray-500 text-sm">No users found</div>
                                                                        : filteredUsers.slice(0, 10).map(u => (
                                                                            <button
                                                                                key={u.id}
                                                                                type="button"
                                                                                onClick={() => handleSelectApprover(role.key, u.id)}
                                                                                className="w-full flex items-center gap-3 p-3 hover:bg-gray-50 transition-colors text-left"
                                                                            >
                                                                                <div className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center flex-shrink-0">
                                                                                    <span className="text-sm font-medium text-gray-600">{u.display_name?.charAt(0)?.toUpperCase() || '?'}</span>
                                                                                </div>
                                                                                <div className="flex-1 min-w-0">
                                                                                    <p className="text-sm font-medium text-gray-900 truncate">{u.display_name}</p>
                                                                                    <p className="text-xs text-gray-500 truncate">{u.email}</p>
                                                                                </div>
                                                                            </button>
                                                                        ))}
                                                            </div>
                                                        )}
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </Card>
                </div>

                {/* Fixed Bottom Actions */}
                <div className="sticky bottom-0 p-4 bg-white/95 backdrop-blur-sm border-t border-gray-100 pb-safe">
                    <div className="flex gap-3 max-w-5xl mx-auto">
                        {isApproverEditing ? (
                            <>
                                <Button type="button" variant="secondary" className="flex-1" onClick={() => router.back()}>Cancel</Button>
                                <Button type="submit" variant="primary" className="flex-1" isLoading={loading}>Save Changes</Button>
                            </>
                        ) : isEditMode ? (
                            <>
                                <Button type="button" variant="secondary" className="flex-1" onClick={() => router.back()}>Cancel</Button>
                                <Button type="submit" variant="primary" className="flex-1" isLoading={loading || savingDraft}>Save Changes</Button>
                            </>
                        ) : (
                            <>
                                <Button type="button" variant="secondary" onClick={handleSaveDraft} isLoading={savingDraft} disabled={loading}>Save Draft</Button>
                                <Button type="button" variant="secondary" className="flex-1" onClick={() => router.back()}>Cancel</Button>
                                <Button type="submit" variant="primary" className="flex-1" isLoading={loading} disabled={savingDraft}>Submit Petty Cash</Button>
                            </>
                        )}
                    </div>
                </div>
            </form>

            <RequestPreviewModal
                isOpen={showPreview}
                onClose={() => setShowPreview(false)}
                mode="preview"
                title="Petty Cash Voucher"
                sections={buildPreviewSections()}
            />
            <RequestPreviewModal
                isOpen={showConfirm}
                onClose={() => setShowConfirm(false)}
                mode="confirm"
                title="Petty Cash Voucher"
                sections={buildPreviewSections()}
                confirming={loading}
                onConfirm={async () => {
                    setShowConfirm(false);
                    await performSubmit();
                }}
            />
            <UnsavedChangesModal
                isOpen={unsavedPrompt.isOpen}
                savingDraft={savingDraft}
                canSaveDraft={!isApproverEditing}
                onSaveDraft={() => unsavedPrompt.saveDraftAndContinue(handleSaveDraft)}
                onDiscard={unsavedPrompt.discardAndContinue}
                onCancel={unsavedPrompt.cancel}
            />
        </AppLayout>
    );
}
