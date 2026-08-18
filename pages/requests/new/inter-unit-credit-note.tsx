import { useSession } from 'next-auth/react';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import { AppLayout } from '../../../components/layout';
import { Card, Button, Input, RequestPreviewModal, UnsavedChangesModal, ReferenceCodeBanner } from '../../../components/ui';
import type { PreviewSection } from '../../../components/ui';
import { useCurrentUser } from '../../../hooks/useCurrentUser';
import { useUnsavedChangesPrompt, useFormAutosave } from '../../../hooks';
import { useUserHrimsProfile } from '../../../hooks/useUserHrimsProfile';
import { useRequestorIdentity } from '../../../hooks/useRequestorIdentity';
import { OnBehalfOfField, type OnBehalfOf } from '../../../components/requests/OnBehalfOfField';
import { isApproverRowLocked } from '../../../lib/approverLocking';
import ApproverSectionLoader from '../../../components/requests/ApproverSectionLoader';

// Business units that can issue or receive an inter-unit credit note. Mirrors
// the cost-allocation list used elsewhere in the finance forms.
const UNIT_OPTIONS: Array<{ code: string; label: string }> = [
    { code: 'CORP', label: 'Corporate (CORP)' },
    { code: 'MRC', label: 'Montclair Resort and Conferencing (MRC)' },
    { code: 'NAH', label: 'New Ambassador Hotel (NAH)' },
    { code: 'RTH', label: 'Rainbow Towers Hotel (RTH)' },
    { code: 'KHCC', label: 'KHCC Conference Centre (KHCC)' },
    { code: 'BRH', label: 'Bulawayo Rainbow Hotel (BRH)' },
    { code: 'VFRH', label: 'Victoria Falls Rainbow Hotel (VFRH)' },
    { code: 'AZAM', label: "A'Zambezi River Lodge (AZAM)" },
];

const CURRENCY_OPTIONS = ['USD', 'ZWG', 'ZAR'];

interface CreditNoteLineItem {
    qty: string;
    description: string;
    invoiceNo: string;
    amount: string;
}

interface SupportingDocument {
    file: File;
    label: string;
    description: string;
}

const emptyLineItem = (): CreditNoteLineItem => ({ qty: '', description: '', invoiceNo: '', amount: '' });

export default function InterUnitCreditNoteRequestPage() {
    const { data: session, status } = useSession();
    const router = useRouter();
    const { user } = useCurrentUser();
    const { departmentName, businessUnitName, businessUnitCode } = useUserHrimsProfile();

    const { edit: editRequestId, approver: isApproverEdit } = router.query;
    const isEditMode = !!editRequestId;
    const isApproverEditing = isApproverEdit === 'true';

    const [loading, setLoading] = useState(false);
    const [savingDraft, setSavingDraft] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [loadingRequest, setLoadingRequest] = useState(false);
    const [referenceCode, setReferenceCode] = useState<string | null>(null);
    const [existingReferenceCode, setExistingReferenceCode] = useState<string | null>(null);

    const todayISO = new Date().toISOString().split('T')[0];

    const [formData, setFormData] = useState({
        date: todayISO,
        creditNoteNumber: '',
        toUnit: '',
        toAccountant: '',
        fromUnit: '',
        fromAccountant: '',
        currency: 'USD',
        remarks: '',
    });

    const [lineItems, setLineItems] = useState<CreditNoteLineItem[]>([emptyLineItem()]);
    const [supportingDocuments, setSupportingDocuments] = useState<SupportingDocument[]>([]);
    const [existingSupportingDocs, setExistingSupportingDocs] = useState<any[]>([]);

    // Original snapshots for approver-edit change tracking.
    const [originalFormData, setOriginalFormData] = useState<typeof formData | null>(null);
    const [originalLineItems, setOriginalLineItems] = useState<CreditNoteLineItem[] | null>(null);
    const [originalApprovers, setOriginalApprovers] = useState<Record<string, string> | null>(null);

    const [isDirty, setIsDirty] = useState(false);

    // Approver workflow for inter-unit credit notes: From-unit Accountant -> From-unit Finance Manager -> To-unit Accountant.
    // Note: from_accountant IS the requestor (they're signing the note themselves), so that slot is
    // auto-filled and locked. The other two roles are auto-resolved from HRIMS.
    const approvalRoles = [
        { key: 'from_accountant', label: 'From Unit Accountant', description: 'Originating accountant (you)' },
        { key: 'from_finance_manager', label: 'From Unit Finance Manager', description: 'Originating unit authorisation' },
        { key: 'to_accountant', label: 'Receiving Unit Accountant', description: 'Receiving unit acknowledgement' },
    ];
    const [users, setUsers] = useState<Array<{ id: string; display_name: string; email: string; job_title?: string }>>([]);
    const [loadingUsers, setLoadingUsers] = useState(true);
    const [selectedApprovers, setSelectedApprovers] = useState<Record<string, string>>({
        from_accountant: '', from_finance_manager: '', to_accountant: '',
    });
    const [approverSearch, setApproverSearch] = useState<Record<string, string>>({
        from_accountant: '', from_finance_manager: '', to_accountant: '',
    });
    const [showApproverDropdown, setShowApproverDropdown] = useState<string | null>(null);
    const [loadingApproverResolution, setLoadingApproverResolution] = useState(!isEditMode);
    const [autoResolvedRoles, setAutoResolvedRoles] = useState<Record<string, boolean>>({});

    // Receiving Accountant search — pulls from app_users (people who have logged into the system).
    const [toAccountantSearch, setToAccountantSearch] = useState('');
    const [showToAccountantDropdown, setShowToAccountantDropdown] = useState(false);
    const [selectedToAccountantId, setSelectedToAccountantId] = useState<string>('');

    // Watchers
    const [selectedWatchers, setSelectedWatchers] = useState<Array<{ id: string; display_name: string; email: string }>>([]);
    const [watcherSearch, setWatcherSearch] = useState('');
    const [onBehalfOf, setOnBehalfOf] = useState<OnBehalfOf | null>(null);
    // Requestor identity shown on the form — the principal when filing on behalf
    // of someone (autofilled on selection), else the signed-in user.
    const requestor = useRequestorIdentity(onBehalfOf);
    const [showWatcherDropdown, setShowWatcherDropdown] = useState(false);

    // Autosave / crash recovery (serializable slices only). Disabled in edit mode.
    useFormAutosave({
        formKey: 'inter-unit-credit-note',
        enabled: !isEditMode,
        data: { formData, lineItems, selectedApprovers, selectedWatchers, selectedToAccountantId },
        onRestore: (saved) => {
            if (saved.formData) setFormData(saved.formData);
            if (Array.isArray(saved.lineItems) && saved.lineItems.length > 0) setLineItems(saved.lineItems);
            if (saved.selectedApprovers) setSelectedApprovers(prev => ({ ...prev, ...saved.selectedApprovers }));
            if (Array.isArray(saved.selectedWatchers)) setSelectedWatchers(saved.selectedWatchers);
            if (typeof saved.selectedToAccountantId === 'string') setSelectedToAccountantId(saved.selectedToAccountantId);
            setIsDirty(true);
        },
    });

    const [showPreview, setShowPreview] = useState(false);
    const [showConfirm, setShowConfirm] = useState(false);

    useEffect(() => {
        if (status === 'unauthenticated') router.push('/');
    }, [status, router]);

    // Hydrate from existing request when editing.
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

                if (metadata.referenceCode) setExistingReferenceCode(metadata.referenceCode);

                const restored = {
                    date: metadata.date || todayISO,
                    creditNoteNumber: metadata.creditNoteNumber || '',
                    toUnit: metadata.toUnit || '',
                    toAccountant: metadata.toAccountant || '',
                    fromUnit: metadata.fromUnit || '',
                    fromAccountant: metadata.fromAccountant || '',
                    currency: metadata.currency || 'USD',
                    remarks: metadata.remarks || '',
                };
                setFormData(restored);
                setOriginalFormData(restored);

                if (Array.isArray(metadata.lineItems) && metadata.lineItems.length > 0) {
                    setLineItems(metadata.lineItems);
                    setOriginalLineItems(metadata.lineItems);
                }

                if (metadata.toAccountantUserId) {
                    setSelectedToAccountantId(metadata.toAccountantUserId);
                }

                if (metadata.supportingDocuments && Array.isArray(metadata.supportingDocuments)) {
                    setExistingSupportingDocs(metadata.supportingDocuments);
                }

                if (Array.isArray(metadata.watchers)) setSelectedWatchers(metadata.watchers);

                const approverRolesData = metadata.approverRoles || {};
                if (approverRolesData && typeof approverRolesData === 'object') {
                    setSelectedApprovers(prev => ({ ...prev, ...approverRolesData }));
                    setOriginalApprovers({ from_accountant: '', from_finance_manager: '', to_accountant: '', ...approverRolesData });
                }
            } catch (err: any) {
                console.error('Error fetching credit note:', err);
                setError('Failed to load request data');
            } finally {
                setLoadingRequest(false);
            }
        };
        if (status === 'authenticated' && editRequestId) fetchExistingRequest();
    }, [editRequestId, status, todayISO]);

    // Default the "From Accountant" name to the requester once their profile loads.
    useEffect(() => {
        if (!isEditMode && !formData.fromAccountant && (user?.display_name || session?.user?.name)) {
            setFormData(prev => ({ ...prev, fromAccountant: user?.display_name || session?.user?.name || '' }));
        }
    }, [isEditMode, formData.fromAccountant, user?.display_name, session?.user?.name]);

    // Auto-fill the originating (From) unit from the requestor's HRIMS business unit.
    // Match the HRIMS code against the local UNIT_OPTIONS so the dropdown picks the
    // right entry. If the requestor's unit isn't in the local list (e.g. a unit
    // outside the standard hotel set) we fall through and let the user pick.
    useEffect(() => {
        if (isEditMode || formData.fromUnit) return;
        if (!businessUnitCode) return;
        const upper = businessUnitCode.toUpperCase();
        const match = UNIT_OPTIONS.find(o => o.code.toUpperCase() === upper);
        if (match) {
            setFormData(prev => ({ ...prev, fromUnit: match.code }));
        }
    }, [businessUnitCode, isEditMode, formData.fromUnit]);

    // Auto-fill the From-Unit Accountant approver row with the requestor — they're
    // signing the credit note themselves, so this step is implicit.
    useEffect(() => {
        if (isEditMode) return;
        const requestorId = user?.id || (session?.user as any)?.id;
        if (requestorId && !selectedApprovers.from_accountant) {
            setSelectedApprovers(prev => ({ ...prev, from_accountant: requestorId }));
            setAutoResolvedRoles(prev => ({ ...prev, from_accountant: true }));
        }
    }, [user?.id, session, isEditMode, selectedApprovers.from_accountant]);

    // Auto-resolve from_finance_manager (and to_accountant once a receiving unit is
    // selected) from the HRIMS organogram. Re-runs whenever toUnit changes so the
    // receiving accountant follows the selected hotel/business unit.
    useEffect(() => {
        const resolveApprovers = async () => {
            if (!session?.user?.email || isEditMode) { setLoadingApproverResolution(false); return; }
            setLoadingApproverResolution(true);
            try {
                const params = new URLSearchParams({
                    email: session.user.email,
                    formType: 'inter-unit-credit-note',
                });
                if (formData.toUnit) params.set('toUnit', formData.toUnit);

                const response = await fetch(`/api/hrims/resolve-approvers?${params.toString()}`);
                const data = await response.json();
                if (!response.ok || !data.approvers) return;

                const updates: Record<string, string> = {};
                const resolved: Record<string, boolean> = {};
                for (const [roleKey, approver] of Object.entries(data.approvers)) {
                    if (approver && (approver as any).userId) {
                        updates[roleKey] = (approver as any).userId;
                        resolved[roleKey] = true;
                    }
                }
                if (Object.keys(updates).length > 0) {
                    setSelectedApprovers(prev => ({ ...prev, ...updates }));
                    setAutoResolvedRoles(prev => ({ ...prev, ...resolved }));
                    // If HRIMS resolves a receiving-unit accountant, mirror it into the
                    // visible "Receiving Accountant" field on the parties section.
                    if (updates.to_accountant) {
                        setSelectedToAccountantId(updates.to_accountant);
                    }
                }
            } catch (err) {
                console.error('Failed to auto-resolve approvers:', err);
            } finally {
                setLoadingApproverResolution(false);
            }
        };
        if (status === 'authenticated') resolveApprovers();
    }, [status, session?.user?.email, isEditMode, formData.toUnit]);

    // Keep the parties' Receiving Accountant name in sync with the chosen user.
    useEffect(() => {
        if (!selectedToAccountantId) return;
        const u = users.find(x => x.id === selectedToAccountantId);
        if (u) {
            setFormData(prev => prev.toAccountant === u.display_name ? prev : { ...prev, toAccountant: u.display_name });
        }
    }, [selectedToAccountantId, users]);

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

    const addLineItem = () => setLineItems(prev => [...prev, emptyLineItem()]);
    const removeLineItem = (index: number) => {
        if (lineItems.length > 1) setLineItems(prev => prev.filter((_, i) => i !== index));
    };
    const updateLineItem = (index: number, field: keyof CreditNoteLineItem, value: string) => {
        setLineItems(prev => prev.map((row, i) => i === index ? { ...row, [field]: value } : row));
    };

    const calculateLineTotal = (row: CreditNoteLineItem): number => {
        const qty = parseFloat(row.qty) || 0;
        const unit = parseFloat(row.amount) || 0;
        return qty * unit;
    };

    const calculateTotal = (): string => {
        const total = lineItems.reduce((sum, row) => sum + calculateLineTotal(row), 0);
        return total.toFixed(2);
    };

    const formatMoney = (value: string | number): string => {
        const n = typeof value === 'number' ? value : parseFloat(value);
        if (!Number.isFinite(n)) return '';
        return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    };

    const getApproverName = (id: string) => users.find(u => u.id === id)?.display_name || id || 'None';
    const getUnitLabel = (code: string) => UNIT_OPTIONS.find(o => o.code === code)?.label || code || '—';

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

    const buildMetadataPayload = () => ({
        type: 'inter_unit_credit_note',
        requestType: 'inter_unit_credit_note',
        referenceCode: existingReferenceCode || referenceCode || undefined,
        date: formData.date,
        creditNoteNumber: formData.creditNoteNumber,
        toUnit: formData.toUnit,
        toAccountant: formData.toAccountant,
        toAccountantUserId: selectedToAccountantId || undefined,
        fromUnit: formData.fromUnit,
        fromAccountant: formData.fromAccountant,
        currency: formData.currency,
        lineItems,
        totalAmount: calculateTotal(),
        remarks: formData.remarks,
        approvers: [
            selectedApprovers.from_accountant,
            selectedApprovers.from_finance_manager,
            selectedApprovers.to_accountant,
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
                    id: user?.id || (session?.user as any)?.id,
                    name: user?.display_name || session?.user?.name || 'Unknown',
                    isApprover: isApproverEditing,
                },
                uploadedAt: new Date().toISOString(),
            })),
        ],
    });

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

    const collectFieldChanges = () => {
        if (!originalFormData) return [];
        const changes: { fieldName: string; oldValue: any; newValue: any }[] = [];

        const compareScalars: Array<keyof typeof formData> = [
            'date', 'creditNoteNumber', 'toUnit', 'toAccountant', 'fromUnit', 'fromAccountant', 'currency', 'remarks',
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
                from_accountant: 'From Unit Accountant',
                from_finance_manager: 'From Unit Finance Manager',
                to_accountant: 'Receiving Unit Accountant',
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

        if (!formData.date) errors.push('Date is required');
        if (!formData.creditNoteNumber.trim()) errors.push('Credit Note Number (CN No.) is required');
        if (!formData.toUnit) errors.push('Receiving (To) unit is required');
        if (!formData.toAccountant.trim()) errors.push('Receiving accountant name is required');
        if (!formData.fromUnit) errors.push('Originating (From) unit is required');
        if (!formData.fromAccountant.trim()) errors.push('From accountant name is required');
        if (formData.toUnit && formData.fromUnit && formData.toUnit === formData.fromUnit) {
            errors.push('Receiving and originating units must be different');
        }
        if (!formData.currency) errors.push('Currency is required');

        const validRows = lineItems.filter(row => row.qty.trim() || row.description.trim() || row.invoiceNo.trim() || row.amount.trim());
        if (validRows.length === 0) errors.push('At least one line item is required');
        for (const [i, row] of validRows.entries()) {
            const num = i + 1;
            if (!row.qty.trim() || parseFloat(row.qty) <= 0) errors.push(`Line ${num}: quantity must be greater than zero`);
            if (!row.description.trim()) errors.push(`Line ${num}: description is required`);
            if (!row.amount || parseFloat(row.amount) <= 0) errors.push(`Line ${num}: unit price must be greater than zero`);
        }

        if (!selectedApprovers.from_accountant) errors.push('From Unit Accountant could not be set from the current user');
        if (!selectedApprovers.from_finance_manager) errors.push('Please select a From Unit Finance Manager approver');
        if (!selectedApprovers.to_accountant) errors.push('Please select a Receiving Unit Accountant approver');

        return errors;
    };

    const handleApproverSave = async () => {
        setLoading(true);
        setError(null);
        try {
            const fieldChanges = collectFieldChanges();
            const response = await fetch(`/api/requests/${editRequestId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title: `Inter-Unit Credit Note: ${formData.creditNoteNumber || 'Request'}`,
                    description: formData.remarks,
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

    const handleDraftSaveExisting = async () => {
        setSavingDraft(true);
        setError(null);
        try {
            const response = await fetch(`/api/requests/${editRequestId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title: `Inter-Unit Credit Note: ${formData.creditNoteNumber || 'Draft'}`,
                    description: formData.remarks || 'Draft credit note',
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
                    title: `Inter-Unit Credit Note: ${formData.creditNoteNumber}`,
                    description: formData.remarks || `Credit note from ${getUnitLabel(formData.fromUnit)} to ${getUnitLabel(formData.toUnit)}`,
                    priority: 'normal',
                    category: 'finance',
                    requestType: 'inter_unit_credit_note',
                    status: 'pending',
                    metadata: buildMetadataPayload(),
                }),
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Failed to create credit note');
            await uploadDocuments(data.request.id);
            router.push(`/requests/${data.request.id}`);
        } catch (err: any) {
            setError(err.message || 'Failed to create credit note');
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
                    title: `Inter-Unit Credit Note: ${formData.creditNoteNumber || 'Draft'}`,
                    description: formData.remarks || 'Draft credit note',
                    priority: 'normal',
                    category: 'finance',
                    requestType: 'inter_unit_credit_note',
                    status: 'draft',
                    metadata: buildMetadataPayload(),
                }),
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Failed to save draft');
            await uploadDocuments(data.request.id);
            router.push(`/requests/${data.request.id}`);
        } catch (err: any) {
            setError(err.message || 'Failed to save draft');
        } finally {
            setSavingDraft(false);
        }
    };

    const handlePrintPreview = () => {
        // Open the preview in print mode — the existing RequestPreviewModal supports this.
        setShowPreview(true);
    };

    const buildPreviewSections = (): PreviewSection[] => [
        {
            title: 'Credit Note Details',
            fields: [
                { label: 'Date', value: formData.date || '—' },
                { label: 'Credit Note No.', value: formData.creditNoteNumber || '—' },
                { label: 'Currency', value: formData.currency || 'USD' },
                { label: 'Total Amount', value: `${formData.currency} ${formatMoney(calculateTotal())}` },
            ],
        },
        {
            title: 'Parties',
            fields: [
                { label: 'To (Receiving Unit)', value: getUnitLabel(formData.toUnit) },
                { label: 'Receiving Accountant', value: formData.toAccountant || '—' },
                { label: 'From (Originating Unit)', value: getUnitLabel(formData.fromUnit) },
                { label: 'From Accountant', value: formData.fromAccountant || '—' },
            ],
        },
        {
            title: 'Line Items',
            content: (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead>
                        <tr>
                            <th style={{ border: '1px solid #333', padding: '6px 8px', background: '#F3EADC', textAlign: 'center', width: '8%' }}>Qty</th>
                            <th style={{ border: '1px solid #333', padding: '6px 8px', background: '#F3EADC', textAlign: 'left' }}>Detail / Description</th>
                            <th style={{ border: '1px solid #333', padding: '6px 8px', background: '#F3EADC', textAlign: 'left', width: '18%' }}>Invoice No.</th>
                            <th style={{ border: '1px solid #333', padding: '6px 8px', background: '#F3EADC', textAlign: 'right', width: '15%' }}>Unit Price ({formData.currency})</th>
                            <th style={{ border: '1px solid #333', padding: '6px 8px', background: '#F3EADC', textAlign: 'right', width: '17%' }}>Line Total ({formData.currency})</th>
                        </tr>
                    </thead>
                    <tbody>
                        {lineItems.filter(r => r.qty || r.description || r.invoiceNo || r.amount).map((row, i) => (
                            <tr key={i}>
                                <td style={{ border: '1px solid #333', padding: '6px 8px', textAlign: 'center' }}>{row.qty || '—'}</td>
                                <td style={{ border: '1px solid #333', padding: '6px 8px' }}>{row.description || '—'}</td>
                                <td style={{ border: '1px solid #333', padding: '6px 8px' }}>{row.invoiceNo || '—'}</td>
                                <td style={{ border: '1px solid #333', padding: '6px 8px', textAlign: 'right' }}>{row.amount ? formatMoney(row.amount) : '—'}</td>
                                <td style={{ border: '1px solid #333', padding: '6px 8px', textAlign: 'right' }}>{(row.qty && row.amount) ? formatMoney(calculateLineTotal(row)) : '—'}</td>
                            </tr>
                        ))}
                        <tr>
                            <td colSpan={4} style={{ border: '1px solid #333', padding: '6px 8px', fontWeight: 700, background: '#F3EADC', textAlign: 'right' }}>TOTAL</td>
                            <td style={{ border: '1px solid #333', padding: '6px 8px', fontWeight: 700, background: '#F3EADC', textAlign: 'right' }}>{formData.currency} {formatMoney(calculateTotal())}</td>
                        </tr>
                    </tbody>
                </table>
            ),
        },
        ...(formData.remarks ? [{
            title: 'Remarks / Reference',
            fields: [{ label: 'Remarks', value: formData.remarks, fullWidth: true }],
        }] : []),
        {
            title: 'Approvers (Sequential)',
            fields: approvalRoles.map(r => ({
                label: r.label,
                value: users.find(u => u.id === selectedApprovers[r.key])?.display_name || 'Not selected',
            })),
        },
        ...(supportingDocuments.length > 0 || existingSupportingDocs.length > 0 ? [{
            title: 'Supporting Documents',
            fields: [
                ...existingSupportingDocs.map((d: any) => ({ label: d.label || d.name || 'Document', value: d.name || '—' })),
                ...supportingDocuments.map((d) => ({ label: d.label || d.file.name, value: d.description || d.file.name })),
            ],
        }] : []),
    ];

    const unsavedPrompt = useUnsavedChangesPrompt({
        isDirty,
        disabled: loading || savingDraft,
    });

    if (status === 'loading' || loadingRequest) {
        return (
            <AppLayout title="Inter-Unit Credit Note" showBack onBack={() => router.back()}>
                <div className="flex items-center justify-center min-h-[60vh]">
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-500" />
                </div>
            </AppLayout>
        );
    }

    if (!session) return null;

    const pageTitle = isApproverEditing
        ? 'Edit Inter-Unit Credit Note (Approver)'
        : isEditMode
            ? 'Edit Inter-Unit Credit Note'
            : 'Inter-Unit Credit Note';

    return (
        <AppLayout title={pageTitle} showBack onBack={() => router.back()} hideNav>
            <form onSubmit={handleSubmit} onChange={() => setIsDirty(true)} className="p-4 sm:p-6 max-w-5xl mx-auto pb-32">
                <div className="mb-6 text-center">
                    <h1 className="text-2xl font-bold text-text-primary font-heading uppercase tracking-wide">
                        Inter-Unit Credit Note
                    </h1>
                    <p className="text-sm text-gray-500 mt-1">DOC NO: FIN APX – INTER-UNIT CREDIT NOTE</p>
                    <div className="mt-4 max-w-lg mx-auto">
                        <ReferenceCodeBanner
                            requestType="inter_unit_credit_note"
                            existingCode={existingReferenceCode || null}
                            onCodeAssigned={setReferenceCode}
                            label="Credit Note Reference"
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

                    {/* Requestor Information */}
                    <Card className="p-6">
                        <h3 className="text-sm font-semibold text-gray-700 mb-4 uppercase border-b pb-2">Requestor Information</h3>
                        {requestor.isOnBehalf && (
                            <p className="text-xs text-primary-700 bg-primary-50 border border-primary-200 rounded-lg px-3 py-2 mb-4">
                                Showing details for <strong>{onBehalfOf?.name}</strong>, on whose behalf you are filing this request.
                            </p>
                        )}
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                            <div>
                                <label className="block text-sm font-semibold text-gray-700 mb-1 uppercase">Name</label>
                                <div className="px-4 py-2 rounded-xl border border-gray-200 bg-gray-50 text-gray-600">
                                    {requestor.name || 'N/A'}
                                </div>
                            </div>
                            <div>
                                <label className="block text-sm font-semibold text-gray-700 mb-1 uppercase">Business Unit</label>
                                <div className="px-4 py-2 rounded-xl border border-gray-200 bg-gray-50 text-gray-600">
                                    {requestor.businessUnit || 'N/A'}
                                </div>
                            </div>
                            <div>
                                <label className="block text-sm font-semibold text-gray-700 mb-1 uppercase">Department</label>
                                <div className="px-4 py-2 rounded-xl border border-gray-200 bg-gray-50 text-gray-600">
                                    {requestor.department || 'N/A'}
                                </div>
                            </div>
                        </div>
                    </Card>

                    {/* Header: Date, CN No., Currency */}
                    <Card className="p-6">
                        <h3 className="text-sm font-semibold text-gray-700 mb-4 uppercase border-b pb-2">Credit Note Header</h3>
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                            <Input
                                type="date"
                                label="Date *"
                                value={formData.date}
                                onChange={(e) => setFormData({ ...formData, date: e.target.value })}
                                required
                            />
                            <div>
                                <label className="block text-sm font-semibold text-gray-700 mb-1 uppercase">CN No. <span className="text-danger-500">*</span></label>
                                <input
                                    type="text"
                                    value={formData.creditNoteNumber}
                                    onChange={(e) => setFormData({ ...formData, creditNoteNumber: e.target.value })}
                                    placeholder="e.g. CN-2026-001"
                                    className="w-full px-4 py-2 rounded-xl border border-gray-300 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none"
                                    required
                                />
                            </div>
                            <div>
                                <label className="block text-sm font-semibold text-gray-700 mb-1 uppercase">Currency <span className="text-danger-500">*</span></label>
                                <select
                                    value={formData.currency}
                                    onChange={(e) => setFormData({ ...formData, currency: e.target.value })}
                                    className="w-full px-4 py-2 rounded-xl border border-gray-300 bg-white focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none"
                                    required
                                >
                                    {CURRENCY_OPTIONS.map(c => (
                                        <option key={c} value={c}>{c}</option>
                                    ))}
                                </select>
                            </div>
                        </div>
                    </Card>

                    {/* Parties: To / From */}
                    <Card className="p-6">
                        <h3 className="text-sm font-semibold text-gray-700 mb-4 uppercase border-b pb-2">Parties</h3>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                            <div className="space-y-3 p-4 rounded-xl bg-[#F3EADC]/40 border border-[#E6D3B3]">
                                <h4 className="text-xs font-bold uppercase tracking-wider text-[#9A7545]">To (Receiving)</h4>
                                <div>
                                    <label className="block text-sm font-semibold text-gray-700 mb-1 uppercase">Receiving Unit <span className="text-danger-500">*</span></label>
                                    <select
                                        value={formData.toUnit}
                                        onChange={(e) => {
                                            const newToUnit = e.target.value;
                                            // Clear any previously-selected receiving accountant
                                            // when the unit changes — HRIMS will re-resolve.
                                            setSelectedToAccountantId('');
                                            setSelectedApprovers(prev => ({ ...prev, to_accountant: '' }));
                                            setAutoResolvedRoles(prev => ({ ...prev, to_accountant: false }));
                                            setFormData(prev => ({ ...prev, toUnit: newToUnit, toAccountant: '' }));
                                        }}
                                        className="w-full px-4 py-2 rounded-xl border border-gray-300 bg-white focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none"
                                        required
                                    >
                                        <option value="">Select unit...</option>
                                        {UNIT_OPTIONS.filter(o => o.code !== formData.fromUnit).map(o => (
                                            <option key={o.code} value={o.code}>{o.label}</option>
                                        ))}
                                    </select>
                                </div>
                                <div className="relative">
                                    <label className="block text-sm font-semibold text-gray-700 mb-1 uppercase">
                                        Receiving Accountant <span className="text-danger-500">*</span>
                                        {autoResolvedRoles.to_accountant && selectedToAccountantId && (
                                            <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-green-50 text-green-700 border border-green-200 normal-case tracking-normal">Auto-resolved</span>
                                        )}
                                    </label>
                                    {showToAccountantDropdown && <div className="fixed inset-0 z-10" onClick={() => setShowToAccountantDropdown(false)} />}
                                    {selectedToAccountantId ? (
                                        (() => {
                                            const u = users.find(x => x.id === selectedToAccountantId);
                                            return (
                                                <div className="flex items-center gap-3 bg-white border border-gray-300 rounded-xl p-2.5">
                                                    <div className="w-8 h-8 rounded-full bg-primary-100 flex items-center justify-center flex-shrink-0">
                                                        <span className="text-sm font-medium text-primary-600">{u?.display_name?.charAt(0)?.toUpperCase() || '?'}</span>
                                                    </div>
                                                    <div className="flex-1 min-w-0">
                                                        <p className="text-sm font-medium text-gray-900 truncate">{u?.display_name || formData.toAccountant}</p>
                                                        <p className="text-xs text-gray-500 truncate">{u?.email || ''}</p>
                                                    </div>
                                                    <button
                                                        type="button"
                                                        onClick={() => { setSelectedToAccountantId(''); setFormData(prev => ({ ...prev, toAccountant: '' })); setAutoResolvedRoles(prev => ({ ...prev, to_accountant: false })); }}
                                                        className="p-1.5 rounded-lg hover:bg-danger-50 text-gray-400 hover:text-danger-500"
                                                        title="Change receiving accountant"
                                                    >
                                                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" /></svg>
                                                    </button>
                                                </div>
                                            );
                                        })()
                                    ) : (
                                        <>
                                            <div className="relative">
                                                <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
                                                <input
                                                    type="text"
                                                    value={toAccountantSearch}
                                                    onChange={(e) => { setToAccountantSearch(e.target.value); setShowToAccountantDropdown(true); }}
                                                    onFocus={() => setShowToAccountantDropdown(true)}
                                                    placeholder="Search users by name or email..."
                                                    className="w-full pl-10 pr-4 py-2 rounded-xl border border-gray-300 bg-white focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none"
                                                />
                                            </div>
                                            {showToAccountantDropdown && (
                                                <div className="absolute z-20 mt-1 w-full bg-white border border-gray-200 rounded-xl shadow-lg max-h-48 overflow-y-auto">
                                                    {loadingUsers
                                                        ? <div className="p-3 text-center text-gray-500 text-sm">Loading users...</div>
                                                        : (() => {
                                                            const filtered = users.filter(u => {
                                                                const t = toAccountantSearch.toLowerCase();
                                                                return !t || u.display_name?.toLowerCase().includes(t) || u.email?.toLowerCase().includes(t);
                                                            }).slice(0, 10);
                                                            return filtered.length === 0
                                                                ? <div className="p-3 text-center text-gray-500 text-sm">No users found</div>
                                                                : filtered.map(u => (
                                                                    <button
                                                                        key={u.id}
                                                                        type="button"
                                                                        onClick={() => {
                                                                            setSelectedToAccountantId(u.id);
                                                                            setFormData(prev => ({ ...prev, toAccountant: u.display_name }));
                                                                            setToAccountantSearch('');
                                                                            setShowToAccountantDropdown(false);
                                                                        }}
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
                                                                ));
                                                        })()}
                                                </div>
                                            )}
                                        </>
                                    )}
                                </div>
                            </div>
                            <div className="space-y-3 p-4 rounded-xl bg-[#F3EADC]/40 border border-[#E6D3B3]">
                                <h4 className="text-xs font-bold uppercase tracking-wider text-[#9A7545]">From (Originating)</h4>
                                <div>
                                    <label className="block text-sm font-semibold text-gray-700 mb-1 uppercase">
                                        From Unit
                                        <span className="ml-2 text-[10px] font-medium text-gray-500 normal-case tracking-normal">(auto-filled from your business unit)</span>
                                    </label>
                                    <div className="w-full px-4 py-2 rounded-xl border border-gray-200 bg-gray-50 text-gray-700">
                                        {formData.fromUnit ? getUnitLabel(formData.fromUnit) : (businessUnitName || 'Not set in HRIMS — contact your administrator')}
                                    </div>
                                </div>
                                <div>
                                    <label className="block text-sm font-semibold text-gray-700 mb-1 uppercase">From Accountant <span className="text-danger-500">*</span></label>
                                    <div className="w-full px-4 py-2 rounded-xl border border-gray-200 bg-gray-50 text-gray-700">
                                        {formData.fromAccountant || user?.display_name || session?.user?.name || '—'}
                                    </div>
                                </div>
                            </div>
                        </div>
                    </Card>

                    {/* Line Items */}
                    <Card className="p-6">
                        <div className="flex items-center justify-between mb-4 border-b pb-2">
                            <h3 className="text-sm font-semibold text-gray-700 uppercase">
                                Line Items <span className="text-danger-500">*</span>
                            </h3>
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
                        </div>
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm border border-gray-300">
                                <thead>
                                    <tr className="bg-gray-50 border-b border-gray-300">
                                        <th className="px-3 py-2 text-center text-xs font-semibold text-gray-700 uppercase border-r border-gray-300 w-20">Qty</th>
                                        <th className="px-3 py-2 text-left text-xs font-semibold text-gray-700 uppercase border-r border-gray-300">Detail / Description</th>
                                        <th className="px-3 py-2 text-left text-xs font-semibold text-gray-700 uppercase border-r border-gray-300 w-36">Invoice No.</th>
                                        <th className="px-3 py-2 text-right text-xs font-semibold text-gray-700 uppercase border-r border-gray-300 w-32">Unit Price ({formData.currency})</th>
                                        <th className="px-3 py-2 text-right text-xs font-semibold text-gray-700 uppercase border-r border-gray-300 w-36">Line Total ({formData.currency})</th>
                                        <th className="px-3 py-2 w-10"></th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {lineItems.map((row, idx) => (
                                        <tr key={idx} className="border-b border-gray-200">
                                            <td className="px-2 py-2 border-r border-gray-200">
                                                <input
                                                    type="number"
                                                    min="0"
                                                    step="1"
                                                    value={row.qty}
                                                    onChange={(e) => updateLineItem(idx, 'qty', e.target.value)}
                                                    placeholder="0"
                                                    className="w-full px-2 py-1 rounded border border-gray-300 focus:ring-1 focus:ring-primary-500 outline-none text-sm text-center"
                                                />
                                            </td>
                                            <td className="px-2 py-2 border-r border-gray-200">
                                                <input
                                                    type="text"
                                                    value={row.description}
                                                    onChange={(e) => updateLineItem(idx, 'description', e.target.value)}
                                                    placeholder="Describe the item"
                                                    className="w-full px-2 py-1 rounded border border-gray-300 focus:ring-1 focus:ring-primary-500 outline-none text-sm"
                                                />
                                            </td>
                                            <td className="px-2 py-2 border-r border-gray-200">
                                                <input
                                                    type="text"
                                                    value={row.invoiceNo}
                                                    onChange={(e) => updateLineItem(idx, 'invoiceNo', e.target.value)}
                                                    placeholder="e.g. INV-1234"
                                                    className="w-full px-2 py-1 rounded border border-gray-300 focus:ring-1 focus:ring-primary-500 outline-none text-sm"
                                                />
                                            </td>
                                            <td className="px-2 py-2 border-r border-gray-200">
                                                <input
                                                    type="number"
                                                    step="0.01"
                                                    min="0"
                                                    value={row.amount}
                                                    onChange={(e) => updateLineItem(idx, 'amount', e.target.value)}
                                                    placeholder="0.00"
                                                    className="w-full px-2 py-1 rounded border border-gray-300 focus:ring-1 focus:ring-primary-500 outline-none text-sm text-right"
                                                />
                                            </td>
                                            <td className="px-3 py-2 border-r border-gray-200 text-right text-sm text-gray-700 tabular-nums">
                                                {(row.qty && row.amount) ? formatMoney(calculateLineTotal(row)) : <span className="text-gray-300">—</span>}
                                            </td>
                                            <td className="px-2 py-2 text-center">
                                                <button
                                                    type="button"
                                                    onClick={() => removeLineItem(idx)}
                                                    disabled={lineItems.length === 1}
                                                    className="text-gray-400 hover:text-danger-500 disabled:opacity-30 disabled:cursor-not-allowed"
                                                    title={lineItems.length === 1 ? 'At least one line is required' : 'Remove line'}
                                                >
                                                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" />
                                                    </svg>
                                                </button>
                                            </td>
                                        </tr>
                                    ))}
                                    <tr className="bg-gray-100 font-semibold border-t-2 border-gray-300">
                                        <td colSpan={4} className="px-3 py-2 text-gray-900 text-right border-r border-gray-200">TOTAL</td>
                                        <td className="px-3 py-2 text-gray-900 text-right border-r border-gray-200 tabular-nums">{formData.currency} {formatMoney(calculateTotal())}</td>
                                        <td></td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>
                    </Card>

                    {/* Remarks / Reference */}
                    <Card className="p-6">
                        <label className="block text-sm font-semibold text-gray-700 mb-2 uppercase border-b pb-2">
                            Remarks / Reference
                        </label>
                        <textarea
                            className="w-full mt-3 px-4 py-3 rounded-xl border border-gray-300 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none transition-all resize-none min-h-[100px]"
                            value={formData.remarks}
                            onChange={(e) => setFormData({ ...formData, remarks: e.target.value })}
                            placeholder="Additional remarks or supporting reference (optional)"
                        />
                    </Card>

                    {/* Supporting Documents */}
                    <Card className="p-6">
                        <div className="flex justify-between items-center mb-4 border-b pb-2">
                            <h3 className="text-sm font-semibold text-gray-700 uppercase">Supporting Documents (Optional)</h3>
                            <div>
                                <input
                                    type="file"
                                    id="iucn-supporting-docs"
                                    className="hidden"
                                    multiple
                                    onChange={handleSupportingDocUpload}
                                />
                                <label
                                    htmlFor="iucn-supporting-docs"
                                    className="inline-flex items-center gap-1 text-sm font-medium text-primary-600 hover:text-primary-700 cursor-pointer"
                                >
                                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4v16m8-8H4" />
                                    </svg>
                                    Add File
                                </label>
                            </div>
                        </div>
                        <p className="text-xs text-gray-500 mb-3">
                            Attach copies of invoices, correspondence or any document supporting this credit note.
                            Add a clear label for each — approvers see the label first.
                        </p>

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
                                            <span className="text-sm text-gray-700 truncate">{doc.label || doc.name}</span>
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
                                                placeholder="Label (e.g. Original Invoice)"
                                                value={doc.label}
                                                onChange={(e) => handleUpdateSupportingDoc(i, 'label', e.target.value)}
                                                className="px-3 py-1.5 text-sm rounded-lg border border-gray-300 focus:ring-1 focus:ring-primary-500 outline-none"
                                            />
                                            <input
                                                type="text"
                                                placeholder="Description (optional)"
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

                    {/* Watchers */}
                    <Card className="p-6">
                        <div className="mb-4 border-b pb-2">
                            <h3 className="text-sm font-semibold text-gray-700 uppercase">Watchers (Optional)</h3>
                            <p className="text-xs text-gray-500 mt-1">Add users who should be notified of this credit note.</p>
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
                            Sequential approval: From Unit Accountant → From Unit Finance Manager → Receiving Unit Accountant.
                            Approvers are auto-assigned from HRIMS; you can override manually if needed.
                        </p>

                        {loadingApproverResolution && <ApproverSectionLoader rows={approvalRoles.length} />}

                        {showApproverDropdown && <div className="fixed inset-0 z-10" onClick={() => setShowApproverDropdown(null)} />}

                        <div className={`space-y-4 ${loadingApproverResolution ? 'hidden' : ''}`}>
                            {approvalRoles.map((role, index) => {
                                const selectedUserId = selectedApprovers[role.key];
                                const selectedUser = selectedUserId ? users.find(u => u.id === selectedUserId) : null;
                                const filteredUsers = getFilteredUsersForRole(role.key);
                                const isAutoResolved = autoResolvedRoles[role.key];
                                const isLocked = isApproverRowLocked(role.key, isAutoResolved);
                                const isRequestorRole = role.key === 'from_accountant';

                                return (
                                    <div key={role.key} className="relative">
                                        <div className="flex items-start gap-4">
                                            <div className="w-10 h-10 rounded-full flex items-center justify-center border-2 bg-primary-50 border-primary-200 text-primary-600 flex-shrink-0 mt-1">
                                                <span className="font-bold text-sm">{index + 1}</span>
                                            </div>
                                            <div className="flex-1">
                                                <div className="mb-2 flex items-center gap-2 flex-wrap">
                                                    <h4 className="font-semibold text-gray-900">{role.label}</h4>
                                                    {isRequestorRole && (
                                                        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-50 text-amber-700 border border-amber-200 uppercase tracking-wide">You — pre-signed</span>
                                                    )}
                                                    {!isRequestorRole && isAutoResolved && selectedUser && (
                                                        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-green-50 text-green-700 border border-green-200 uppercase tracking-wide">Auto-assigned</span>
                                                    )}
                                                </div>
                                                <p className="text-xs text-gray-500 -mt-1 mb-2">{role.description}</p>
                                                {selectedUser ? (
                                                    <div className={`flex items-center gap-3 p-3 rounded-xl ${isRequestorRole ? 'bg-amber-50 border border-amber-200' : isAutoResolved ? 'bg-green-50 border border-green-200' : 'bg-primary-50 border border-primary-200'}`}>
                                                        <div className={`w-8 h-8 rounded-full ${isRequestorRole ? 'bg-amber-100' : isAutoResolved ? 'bg-green-100' : 'bg-primary-100'} flex items-center justify-center flex-shrink-0`}>
                                                            <span className={`text-sm font-medium ${isRequestorRole ? 'text-amber-700' : isAutoResolved ? 'text-green-700' : 'text-primary-600'}`}>{selectedUser.display_name?.charAt(0)?.toUpperCase() || '?'}</span>
                                                        </div>
                                                        <div className="flex-1 min-w-0">
                                                            <p className="text-sm font-medium text-gray-900 truncate">{selectedUser.display_name}</p>
                                                            <p className="text-xs text-gray-500 truncate">{selectedUser.email}</p>
                                                            {isRequestorRole && <p className="text-xs text-amber-700 mt-0.5">Signs automatically on submission</p>}
                                                            {!isRequestorRole && isAutoResolved && <p className="text-xs text-green-700 mt-0.5">Auto-assigned from HRIMS organogram{isLocked ? ' · locked' : ''}</p>}
                                                        </div>
                                                        {/* Senior fixed approvers (CEO, HRD, directors) are locked once
                                                            auto-resolved; departmental/managerial rows stay changeable. */}
                                                        {!isRequestorRole && !isLocked && (
                                                            <button
                                                                type="button"
                                                                onClick={() => { handleRemoveApprover(role.key); setAutoResolvedRoles(prev => ({ ...prev, [role.key]: false })); }}
                                                                className="p-1.5 rounded-lg hover:bg-danger-50 text-gray-400 hover:text-danger-500"
                                                                title="Remove approver"
                                                            >
                                                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" /></svg>
                                                            </button>
                                                        )}
                                                    </div>
                                                ) : (
                                                    <div className="relative">
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
                    <div className="flex gap-3 max-w-5xl mx-auto flex-wrap">
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
                                <Button type="button" variant="secondary" onClick={handlePrintPreview} disabled={loading || savingDraft}>Preview / Print</Button>
                                <Button type="button" variant="secondary" className="flex-1" onClick={() => router.back()}>Cancel</Button>
                                <Button type="submit" variant="primary" className="flex-1" isLoading={loading} disabled={savingDraft}>Submit for Approval</Button>
                            </>
                        )}
                    </div>
                </div>
            </form>

            <RequestPreviewModal
                isOpen={showPreview}
                onClose={() => setShowPreview(false)}
                mode="preview"
                title="Inter-Unit Credit Note"
                sections={buildPreviewSections()}
            />
            <RequestPreviewModal
                isOpen={showConfirm}
                onClose={() => setShowConfirm(false)}
                mode="confirm"
                title="Inter-Unit Credit Note"
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
