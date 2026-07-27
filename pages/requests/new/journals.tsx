import { useSession } from 'next-auth/react';
import { useRouter } from 'next/router';
import { useEffect, useMemo, useState } from 'react';
import { AppLayout } from '../../../components/layout';
import {
    Card,
    Button,
    Input,
    RequestPreviewModal,
    UnsavedChangesModal,
    ReferenceCodeBanner,
} from '../../../components/ui';
import type { PreviewSection, DocumentHeader } from '../../../components/ui';
import { useCurrentUser } from '../../../hooks/useCurrentUser';
import { useUnsavedChangesPrompt, useFormAutosave } from '../../../hooks';
import { useUserHrimsProfile } from '../../../hooks/useUserHrimsProfile';
import { OnBehalfOfField, type OnBehalfOf } from '../../../components/requests/OnBehalfOfField';

const CURRENCY_OPTIONS = ['USD', 'ZWG'];

const JOURNAL_TYPE_OPTIONS: Array<{ value: string; label: string }> = [
    { value: 'general', label: 'General Journal' },
    { value: 'adjustment', label: 'Adjustment Journal' },
    { value: 'reversing', label: 'Reversing Journal' },
    { value: 'recurring', label: 'Recurring Journal' },
    { value: 'accrual', label: 'Accrual Journal' },
    { value: 'reclassification', label: 'Reclassification Journal' },
    { value: 'closing', label: 'Closing Journal' },
];

interface JournalLine {
    accountCode: string;
    accountName: string;
    description: string;
    debit: string;
    credit: string;
}

const emptyLine = (): JournalLine => ({
    accountCode: '',
    accountName: '',
    description: '',
    debit: '',
    credit: '',
});

const JOURNAL_DOCUMENT_HEADER: DocumentHeader = {
    logoUrl: '/images/RTG_LOGO.png',
    docNo: 'DOC NO: FIN APX – JOURNAL ENTRY',
    department: 'DEPARTMENT: FINANCE',
    page: 'PAGE: 1 of 1',
};

export default function JournalEntryPage() {
    const { data: session, status } = useSession();
    const router = useRouter();
    const { user } = useCurrentUser();
    const { departmentName, businessUnitName } = useUserHrimsProfile();

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
        journalType: 'general',
        batchNo: '',
        glBatchNo: '',
        date: todayISO,
        referenceNo: '',
        currency: 'USD',
        narration: '',
    });

    const [lines, setLines] = useState<JournalLine[]>([emptyLine(), emptyLine()]);

    const [originalFormData, setOriginalFormData] = useState<typeof formData | null>(null);
    const [originalLines, setOriginalLines] = useState<JournalLine[] | null>(null);
    const [originalApprovers, setOriginalApprovers] = useState<Record<string, string> | null>(null);

    const [isDirty, setIsDirty] = useState(false);

    // Sequential approvers — Preparer (requestor, pre-signed) → Reviewer → Authoriser.
    const approvalRoles = [
        { key: 'preparer', label: 'Preparer', description: 'Originating officer (you)' },
        { key: 'reviewer', label: 'Reviewer', description: 'Accountant / Senior reviewer' },
        { key: 'authoriser', label: 'Authoriser', description: 'Finance Manager or designate' },
    ];
    const [users, setUsers] = useState<Array<{ id: string; display_name: string; email: string; job_title?: string }>>([]);
    const [loadingUsers, setLoadingUsers] = useState(true);
    const [selectedApprovers, setSelectedApprovers] = useState<Record<string, string>>({
        preparer: '', reviewer: '', authoriser: '',
    });
    const [approverSearch, setApproverSearch] = useState<Record<string, string>>({
        preparer: '', reviewer: '', authoriser: '',
    });
    const [showApproverDropdown, setShowApproverDropdown] = useState<string | null>(null);

    const [selectedWatchers, setSelectedWatchers] = useState<Array<{ id: string; display_name: string; email: string }>>([]);
    const [onBehalfOf, setOnBehalfOf] = useState<OnBehalfOf | null>(null);
    const [watcherSearch, setWatcherSearch] = useState('');
    const [showWatcherDropdown, setShowWatcherDropdown] = useState(false);

    // Autosave / crash recovery (serializable slices only). Disabled in edit mode.
    useFormAutosave({
        formKey: 'journals',
        enabled: !isEditMode,
        data: { formData, lines, selectedApprovers, selectedWatchers },
        onRestore: (saved) => {
            if (saved.formData) setFormData(saved.formData);
            if (Array.isArray(saved.lines) && saved.lines.length > 0) setLines(saved.lines);
            if (saved.selectedApprovers) setSelectedApprovers(prev => ({ ...prev, ...saved.selectedApprovers }));
            if (Array.isArray(saved.selectedWatchers)) setSelectedWatchers(saved.selectedWatchers);
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
                const metadata = data.request?.metadata || {};

                if (metadata.referenceCode) setExistingReferenceCode(metadata.referenceCode);

                const restored = {
                    journalType: metadata.journalType || 'general',
                    batchNo: metadata.batchNo || '',
                    glBatchNo: metadata.glBatchNo || '',
                    date: metadata.date || todayISO,
                    referenceNo: metadata.referenceNo || '',
                    currency: metadata.currency || 'USD',
                    narration: metadata.narration || '',
                };
                setFormData(restored);
                setOriginalFormData(restored);

                if (Array.isArray(metadata.lines) && metadata.lines.length > 0) {
                    setLines(metadata.lines);
                    setOriginalLines(metadata.lines);
                }

                if (Array.isArray(metadata.watchers)) setSelectedWatchers(metadata.watchers);

                const approverRolesData = metadata.approverRoles || {};
                if (approverRolesData && typeof approverRolesData === 'object') {
                    setSelectedApprovers(prev => ({ ...prev, ...approverRolesData }));
                    setOriginalApprovers({ preparer: '', reviewer: '', authoriser: '', ...approverRolesData });
                }
            } catch (err: any) {
                console.error('Error fetching journal:', err);
                setError('Failed to load request data');
            } finally {
                setLoadingRequest(false);
            }
        };
        if (status === 'authenticated' && editRequestId) fetchExistingRequest();
    }, [editRequestId, status, todayISO]);

    // Pin the preparer to the current user — they sign the journal themselves on submission.
    useEffect(() => {
        if (isEditMode) return;
        const requestorId = user?.id || (session?.user as any)?.id;
        if (requestorId && !selectedApprovers.preparer) {
            setSelectedApprovers(prev => ({ ...prev, preparer: requestorId }));
        }
    }, [user?.id, session, isEditMode, selectedApprovers.preparer]);

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

    // Line operations.
    const addLine = () => setLines(prev => [...prev, emptyLine()]);
    const removeLine = (index: number) => {
        if (lines.length > 2) setLines(prev => prev.filter((_, i) => i !== index));
    };
    const updateLine = (index: number, field: keyof JournalLine, value: string) => {
        setLines(prev => prev.map((row, i) => {
            if (i !== index) return row;
            // If a row receives a debit amount, clear its credit (and vice-versa) — a
            // single line can't be both sides of an entry in standard journal practice.
            if (field === 'debit' && value) return { ...row, debit: value, credit: '' };
            if (field === 'credit' && value) return { ...row, credit: value, debit: '' };
            return { ...row, [field]: value };
        }));
    };

    const parseAmount = (v: string): number => {
        const n = parseFloat(v);
        return Number.isFinite(n) ? n : 0;
    };

    const totals = useMemo(() => {
        const debit = lines.reduce((sum, row) => sum + parseAmount(row.debit), 0);
        const credit = lines.reduce((sum, row) => sum + parseAmount(row.credit), 0);
        const diff = Math.round((debit - credit) * 100) / 100;
        return { debit, credit, diff };
    }, [lines]);

    const isBalanced = totals.diff === 0 && (totals.debit > 0 || totals.credit > 0);

    const formatMoney = (value: string | number): string => {
        const n = typeof value === 'number' ? value : parseFloat(value);
        if (!Number.isFinite(n)) return '';
        return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    };

    const getApproverName = (id: string) => users.find(u => u.id === id)?.display_name || id || 'None';
    const getJournalTypeLabel = (v: string) => JOURNAL_TYPE_OPTIONS.find(o => o.value === v)?.label || v || '—';

    // Approver helpers.
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

    // Watcher helpers.
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

    const buildMetadataPayload = () => ({
        type: 'journal',
        requestType: 'journal',
        referenceCode: existingReferenceCode || referenceCode || undefined,
        journalType: formData.journalType,
        batchNo: formData.batchNo,
        glBatchNo: formData.glBatchNo,
        date: formData.date,
        referenceNo: formData.referenceNo,
        currency: formData.currency,
        narration: formData.narration,
        lines,
        totalDebit: totals.debit.toFixed(2),
        totalCredit: totals.credit.toFixed(2),
        balanced: isBalanced,
        approvers: [
            selectedApprovers.preparer,
            selectedApprovers.reviewer,
            selectedApprovers.authoriser,
        ].filter(Boolean),
        approverRoles: selectedApprovers,
        useParallelApprovals: false,
        onBehalfOf: onBehalfOf || null,
        watchers: selectedWatchers,
    });

    const collectFieldChanges = () => {
        if (!originalFormData) return [];
        const changes: { fieldName: string; oldValue: any; newValue: any }[] = [];
        const scalars: Array<keyof typeof formData> = [
            'journalType', 'batchNo', 'glBatchNo', 'date', 'referenceNo', 'currency', 'narration',
        ];
        for (const f of scalars) {
            if (formData[f] !== originalFormData[f]) {
                changes.push({ fieldName: String(f), oldValue: originalFormData[f], newValue: formData[f] });
            }
        }
        if (originalLines && JSON.stringify(lines) !== JSON.stringify(originalLines)) {
            changes.push({ fieldName: 'lines', oldValue: JSON.stringify(originalLines), newValue: JSON.stringify(lines) });
        }
        if (originalApprovers) {
            const labels: Record<string, string> = {
                preparer: 'Preparer',
                reviewer: 'Reviewer',
                authoriser: 'Authoriser',
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

        if (!formData.journalType) errors.push('Journal Type is required');
        if (!formData.date) errors.push('Date is required');
        if (!formData.currency) errors.push('Currency is required');
        if (!formData.narration.trim()) errors.push('Description / Narration is required');

        const validRows = lines.filter(r => r.accountCode.trim() || r.accountName.trim() || r.description.trim() || r.debit.trim() || r.credit.trim());
        if (validRows.length < 2) errors.push('A journal must have at least two posted lines');

        for (const [i, row] of validRows.entries()) {
            const n = i + 1;
            if (!row.accountCode.trim()) errors.push(`Line ${n}: Account code is required`);
            if (!row.accountName.trim()) errors.push(`Line ${n}: Account name is required`);
            const d = parseAmount(row.debit);
            const c = parseAmount(row.credit);
            if (d === 0 && c === 0) errors.push(`Line ${n}: enter either a debit or a credit amount`);
            if (d > 0 && c > 0) errors.push(`Line ${n}: a line cannot have both debit and credit amounts`);
        }

        if (totals.debit === 0 && totals.credit === 0) {
            errors.push('Journal totals must be greater than zero');
        } else if (totals.diff !== 0) {
            errors.push(`Journal is not balanced — Debit (${formatMoney(totals.debit)}) does not equal Credit (${formatMoney(totals.credit)}). Difference: ${formatMoney(Math.abs(totals.diff))}`);
        }

        if (!selectedApprovers.preparer) errors.push('Preparer could not be set from the current user');
        if (!selectedApprovers.reviewer) errors.push('Please select a Reviewer');
        if (!selectedApprovers.authoriser) errors.push('Please select an Authoriser');

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
                    title: `Journal Entry: ${formData.referenceNo || formData.batchNo || 'Request'}`,
                    description: formData.narration,
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
                    title: `Journal Entry: ${formData.referenceNo || formData.batchNo || 'Draft'}`,
                    description: formData.narration || 'Draft journal entry',
                    metadata: buildMetadataPayload(),
                }),
            });
            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || 'Failed to save draft');
            }
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

        const errors = validate();
        if (errors.length > 0) {
            setError(errors.join('. '));
            return;
        }
        setError(null);
        setShowConfirm(true);
    };

    const performSubmit = async () => {
        setLoading(true);
        setError(null);
        try {
            const response = await fetch('/api/requests', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title: `Journal Entry: ${formData.referenceNo || formData.batchNo || getJournalTypeLabel(formData.journalType)}`,
                    description: formData.narration,
                    priority: 'normal',
                    category: 'finance',
                    requestType: 'journal',
                    status: 'pending',
                    metadata: buildMetadataPayload(),
                }),
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Failed to create journal');
            router.push(`/requests/${data.request.id}`);
        } catch (err: any) {
            setError(err.message || 'Failed to create journal');
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
                    title: `Journal Entry: ${formData.referenceNo || formData.batchNo || 'Draft'}`,
                    description: formData.narration || 'Draft journal entry',
                    priority: 'normal',
                    category: 'finance',
                    requestType: 'journal',
                    status: 'draft',
                    metadata: buildMetadataPayload(),
                }),
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Failed to save draft');
            router.push(`/requests/${data.request.id}`);
        } catch (err: any) {
            setError(err.message || 'Failed to save draft');
        } finally {
            setSavingDraft(false);
        }
    };

    // Shared inline styles for preview/print so the on-screen card and printed
    // copy match the original document layout.
    const cellStyle: React.CSSProperties = { border: '1px solid #333', padding: '6px 8px', verticalAlign: 'top', fontSize: 11 };
    const headCellStyle: React.CSSProperties = { ...cellStyle, background: '#F3EADC', color: '#5E4426', fontWeight: 700, textAlign: 'left' };

    const buildPreviewSections = (): PreviewSection[] => [
        {
            title: 'Journal Header',
            fields: [
                { label: 'Journal Type', value: getJournalTypeLabel(formData.journalType) },
                { label: 'Batch No.', value: formData.batchNo || '—' },
                { label: 'GL Batch No.', value: formData.glBatchNo || '—' },
                { label: 'Date', value: formData.date || '—' },
                { label: 'Reference No.', value: formData.referenceNo || '—' },
                { label: 'Currency', value: formData.currency || 'USD' },
            ],
        },
        {
            title: 'Description / Narration',
            fields: [{ label: 'Narration', value: formData.narration || '—', fullWidth: true }],
        },
        {
            title: 'Journal Lines',
            content: (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                    <thead>
                        <tr>
                            <th style={{ ...headCellStyle, textAlign: 'center', width: '5%' }}>#</th>
                            <th style={{ ...headCellStyle, width: '13%' }}>Account Code</th>
                            <th style={{ ...headCellStyle, width: '22%' }}>Account Name</th>
                            <th style={{ ...headCellStyle }}>Description</th>
                            <th style={{ ...headCellStyle, textAlign: 'right', width: '15%' }}>Debit ({formData.currency})</th>
                            <th style={{ ...headCellStyle, textAlign: 'right', width: '15%' }}>Credit ({formData.currency})</th>
                        </tr>
                    </thead>
                    <tbody>
                        {lines
                            .filter(r => r.accountCode || r.accountName || r.description || r.debit || r.credit)
                            .map((row, i) => (
                                <tr key={i}>
                                    <td style={{ ...cellStyle, textAlign: 'center' }}>{i + 1}</td>
                                    <td style={cellStyle}>{row.accountCode || '—'}</td>
                                    <td style={cellStyle}>{row.accountName || '—'}</td>
                                    <td style={cellStyle}>{row.description || '—'}</td>
                                    <td style={{ ...cellStyle, textAlign: 'right' }}>{row.debit ? formatMoney(row.debit) : '—'}</td>
                                    <td style={{ ...cellStyle, textAlign: 'right' }}>{row.credit ? formatMoney(row.credit) : '—'}</td>
                                </tr>
                            ))}
                        <tr>
                            <td colSpan={4} style={{ ...cellStyle, fontWeight: 700, background: '#F3EADC', textAlign: 'right' }}>TOTALS</td>
                            <td style={{ ...cellStyle, fontWeight: 700, background: '#F3EADC', textAlign: 'right' }}>{formData.currency} {formatMoney(totals.debit)}</td>
                            <td style={{ ...cellStyle, fontWeight: 700, background: '#F3EADC', textAlign: 'right' }}>{formData.currency} {formatMoney(totals.credit)}</td>
                        </tr>
                        <tr>
                            <td
                                colSpan={6}
                                style={{
                                    ...cellStyle,
                                    background: isBalanced ? '#ECFDF5' : '#FEF3C7',
                                    color: isBalanced ? '#065F46' : '#92400E',
                                    fontWeight: 700,
                                    textAlign: 'center',
                                }}
                            >
                                {isBalanced
                                    ? `BALANCED — Debit = Credit = ${formData.currency} ${formatMoney(totals.debit)}`
                                    : `NOT BALANCED — Difference: ${formData.currency} ${formatMoney(Math.abs(totals.diff))}`}
                            </td>
                        </tr>
                    </tbody>
                </table>
            ),
        },
        {
            title: 'Approvers (Sequential)',
            fields: approvalRoles.map(r => ({
                label: r.label,
                value: users.find(u => u.id === selectedApprovers[r.key])?.display_name || 'Not selected',
            })),
        },
    ];

    const unsavedPrompt = useUnsavedChangesPrompt({
        isDirty,
        disabled: loading || savingDraft,
    });

    if (status === 'loading' || loadingRequest) {
        return (
            <AppLayout title="Journal Entry" showBack onBack={() => router.back()}>
                <div className="flex items-center justify-center min-h-[60vh]">
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-500" />
                </div>
            </AppLayout>
        );
    }

    if (!session) return null;

    const pageTitle = isApproverEditing
        ? 'Edit Journal Entry (Approver)'
        : isEditMode
            ? 'Edit Journal Entry'
            : 'Journal Entry';

    return (
        <AppLayout title={pageTitle} showBack onBack={() => router.back()} hideNav>
            <form onSubmit={handleSubmit} onChange={() => setIsDirty(true)} className="p-4 sm:p-6 max-w-5xl mx-auto pb-32">
                {/* Document header — RTG logo + identifier strip, matching the printed layout */}
                <div className="mb-6">
                    <div className="text-center">
                        <img
                            src="/images/RTG_LOGO.png"
                            alt="RTG"
                            className="inline-block max-h-16 w-auto"
                        />
                    </div>
                    <table className="w-full border border-gray-800 mt-3 text-[11px] hidden sm:table">
                        <tbody>
                            <tr>
                                <td className="border border-gray-800 px-3 py-1.5 font-semibold text-left w-2/5">{JOURNAL_DOCUMENT_HEADER.docNo}</td>
                                <td className="border border-gray-800 px-3 py-1.5 font-semibold text-center w-2/5">{JOURNAL_DOCUMENT_HEADER.department}</td>
                                <td className="border border-gray-800 px-3 py-1.5 font-semibold text-right w-1/5">{JOURNAL_DOCUMENT_HEADER.page}</td>
                            </tr>
                        </tbody>
                    </table>
                    <h1 className="mt-4 text-2xl font-bold text-text-primary font-heading uppercase tracking-wide text-center">
                        Journal Entry
                    </h1>
                    <div className="mt-4 max-w-lg mx-auto">
                        <ReferenceCodeBanner
                            requestType="journal"
                            existingCode={existingReferenceCode || null}
                            onCodeAssigned={setReferenceCode}
                            label="Journal Reference"
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
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
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
                        </div>
                    </Card>

                    {/* Journal Header fields */}
                    <Card className="p-6">
                        <h3 className="text-sm font-semibold text-gray-700 mb-4 uppercase border-b pb-2">Journal Header</h3>
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                            <div>
                                <label className="block text-sm font-semibold text-gray-700 mb-1 uppercase">Journal Type <span className="text-danger-500">*</span></label>
                                <select
                                    value={formData.journalType}
                                    onChange={(e) => setFormData({ ...formData, journalType: e.target.value })}
                                    className="w-full px-4 py-2 rounded-xl border border-gray-300 bg-white focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none"
                                    required
                                >
                                    {JOURNAL_TYPE_OPTIONS.map(o => (
                                        <option key={o.value} value={o.value}>{o.label}</option>
                                    ))}
                                </select>
                            </div>
                            <div>
                                <label className="block text-sm font-semibold text-gray-700 mb-1 uppercase">Batch No.</label>
                                <input
                                    type="text"
                                    value={formData.batchNo}
                                    onChange={(e) => setFormData({ ...formData, batchNo: e.target.value })}
                                    placeholder="e.g. BCH-2026-001"
                                    className="w-full px-4 py-2 rounded-xl border border-gray-300 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none"
                                />
                            </div>
                            <div>
                                <label className="block text-sm font-semibold text-gray-700 mb-1 uppercase">GL Batch No.</label>
                                <input
                                    type="text"
                                    value={formData.glBatchNo}
                                    onChange={(e) => setFormData({ ...formData, glBatchNo: e.target.value })}
                                    placeholder="e.g. GL-2026-001"
                                    className="w-full px-4 py-2 rounded-xl border border-gray-300 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none"
                                />
                            </div>
                            <Input
                                type="date"
                                label="Date *"
                                value={formData.date}
                                onChange={(e) => setFormData({ ...formData, date: e.target.value })}
                                required
                            />
                            <div>
                                <label className="block text-sm font-semibold text-gray-700 mb-1 uppercase">Reference No.</label>
                                <input
                                    type="text"
                                    value={formData.referenceNo}
                                    onChange={(e) => setFormData({ ...formData, referenceNo: e.target.value })}
                                    placeholder="e.g. JNL-2026-0001"
                                    className="w-full px-4 py-2 rounded-xl border border-gray-300 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none"
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

                    {/* Description / Narration */}
                    <Card className="p-6">
                        <label className="block text-sm font-semibold text-gray-700 mb-2 uppercase border-b pb-2">
                            Description / Narration <span className="text-danger-500">*</span>
                        </label>
                        <textarea
                            className="w-full mt-3 px-4 py-3 rounded-xl border border-gray-300 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none transition-all resize-none min-h-[100px]"
                            value={formData.narration}
                            onChange={(e) => setFormData({ ...formData, narration: e.target.value })}
                            placeholder="Explain the purpose of this journal entry (e.g. To record accrual of audit fees for the year ended 31 December)"
                            required
                        />
                    </Card>

                    {/* Journal Lines */}
                    <Card className="p-6">
                        <div className="flex items-center justify-between mb-4 border-b pb-2">
                            <h3 className="text-sm font-semibold text-gray-700 uppercase">
                                Journal Lines <span className="text-danger-500">*</span>
                            </h3>
                            <button
                                type="button"
                                onClick={addLine}
                                className="inline-flex items-center gap-1 text-sm font-medium text-primary-600 hover:text-primary-700"
                            >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4v16m8-8H4" />
                                </svg>
                                Add Line
                            </button>
                        </div>
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm border border-gray-300 min-w-[860px]">
                                <thead>
                                    <tr className="bg-[#F3EADC] border-b border-gray-300">
                                        <th className="px-2 py-2 text-center text-xs font-semibold text-[#5E4426] uppercase border-r border-gray-300 w-10">#</th>
                                        <th className="px-3 py-2 text-left text-xs font-semibold text-[#5E4426] uppercase border-r border-gray-300 w-32">Account Code</th>
                                        <th className="px-3 py-2 text-left text-xs font-semibold text-[#5E4426] uppercase border-r border-gray-300 w-48">Account Name</th>
                                        <th className="px-3 py-2 text-left text-xs font-semibold text-[#5E4426] uppercase border-r border-gray-300">Description</th>
                                        <th className="px-3 py-2 text-right text-xs font-semibold text-[#5E4426] uppercase border-r border-gray-300 w-36">Debit ({formData.currency})</th>
                                        <th className="px-3 py-2 text-right text-xs font-semibold text-[#5E4426] uppercase border-r border-gray-300 w-36">Credit ({formData.currency})</th>
                                        <th className="px-2 py-2 w-10"></th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {lines.map((row, idx) => (
                                        <tr key={idx} className="border-b border-gray-200">
                                            <td className="px-2 py-2 text-center text-sm text-gray-500 border-r border-gray-200 tabular-nums">{idx + 1}</td>
                                            <td className="px-2 py-2 border-r border-gray-200">
                                                <input
                                                    type="text"
                                                    value={row.accountCode}
                                                    onChange={(e) => updateLine(idx, 'accountCode', e.target.value)}
                                                    placeholder="e.g. 6100"
                                                    className="w-full px-2 py-1 rounded border border-gray-300 focus:ring-1 focus:ring-primary-500 outline-none text-sm tabular-nums"
                                                />
                                            </td>
                                            <td className="px-2 py-2 border-r border-gray-200">
                                                <input
                                                    type="text"
                                                    value={row.accountName}
                                                    onChange={(e) => updateLine(idx, 'accountName', e.target.value)}
                                                    placeholder="e.g. Audit Fees"
                                                    className="w-full px-2 py-1 rounded border border-gray-300 focus:ring-1 focus:ring-primary-500 outline-none text-sm"
                                                />
                                            </td>
                                            <td className="px-2 py-2 border-r border-gray-200">
                                                <input
                                                    type="text"
                                                    value={row.description}
                                                    onChange={(e) => updateLine(idx, 'description', e.target.value)}
                                                    placeholder="Line narration (optional)"
                                                    className="w-full px-2 py-1 rounded border border-gray-300 focus:ring-1 focus:ring-primary-500 outline-none text-sm"
                                                />
                                            </td>
                                            <td className="px-2 py-2 border-r border-gray-200">
                                                <input
                                                    type="number"
                                                    inputMode="decimal"
                                                    step="0.01"
                                                    min="0"
                                                    value={row.debit}
                                                    onChange={(e) => updateLine(idx, 'debit', e.target.value)}
                                                    placeholder="0.00"
                                                    className="w-full px-2 py-1 rounded border border-gray-300 focus:ring-1 focus:ring-primary-500 outline-none text-sm text-right tabular-nums"
                                                />
                                            </td>
                                            <td className="px-2 py-2 border-r border-gray-200">
                                                <input
                                                    type="number"
                                                    inputMode="decimal"
                                                    step="0.01"
                                                    min="0"
                                                    value={row.credit}
                                                    onChange={(e) => updateLine(idx, 'credit', e.target.value)}
                                                    placeholder="0.00"
                                                    className="w-full px-2 py-1 rounded border border-gray-300 focus:ring-1 focus:ring-primary-500 outline-none text-sm text-right tabular-nums"
                                                />
                                            </td>
                                            <td className="px-2 py-2 text-center">
                                                <button
                                                    type="button"
                                                    onClick={() => removeLine(idx)}
                                                    disabled={lines.length <= 2}
                                                    className="text-gray-400 hover:text-danger-500 disabled:opacity-30 disabled:cursor-not-allowed"
                                                    title={lines.length <= 2 ? 'A journal requires at least two lines' : 'Remove line'}
                                                >
                                                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" />
                                                    </svg>
                                                </button>
                                            </td>
                                        </tr>
                                    ))}
                                    <tr className="bg-gray-100 font-semibold border-t-2 border-gray-300">
                                        <td colSpan={4} className="px-3 py-2 text-gray-900 text-right border-r border-gray-200 uppercase tracking-wide text-xs">Totals</td>
                                        <td className="px-3 py-2 text-gray-900 text-right border-r border-gray-200 tabular-nums">{formData.currency} {formatMoney(totals.debit)}</td>
                                        <td className="px-3 py-2 text-gray-900 text-right border-r border-gray-200 tabular-nums">{formData.currency} {formatMoney(totals.credit)}</td>
                                        <td></td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>

                        {/* Balance indicator — accountant-style banner */}
                        <div
                            className={`mt-4 px-4 py-3 rounded-xl border flex items-center justify-between gap-3 flex-wrap ${
                                totals.debit === 0 && totals.credit === 0
                                    ? 'bg-gray-50 border-gray-200 text-gray-600'
                                    : isBalanced
                                        ? 'bg-green-50 border-green-200 text-green-800'
                                        : 'bg-amber-50 border-amber-200 text-amber-800'
                            }`}
                        >
                            <div className="flex items-center gap-2">
                                {isBalanced ? (
                                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                                    </svg>
                                ) : (
                                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                                    </svg>
                                )}
                                <span className="font-semibold text-sm uppercase tracking-wide">
                                    {totals.debit === 0 && totals.credit === 0
                                        ? 'Enter debit and credit amounts'
                                        : isBalanced
                                            ? 'Balanced'
                                            : 'Not balanced'}
                                </span>
                            </div>
                            <div className="text-sm tabular-nums">
                                <span className="mr-4">Total Debit: <strong>{formData.currency} {formatMoney(totals.debit)}</strong></span>
                                <span className="mr-4">Total Credit: <strong>{formData.currency} {formatMoney(totals.credit)}</strong></span>
                                <span>Difference: <strong>{formData.currency} {formatMoney(Math.abs(totals.diff))}</strong></span>
                            </div>
                        </div>
                    </Card>

                    {/* Watchers */}
                    <Card className="p-6">
                        <div className="mb-4 border-b pb-2">
                            <h3 className="text-sm font-semibold text-gray-700 uppercase">Watchers (Optional)</h3>
                            <p className="text-xs text-gray-500 mt-1">Add users who should be notified of this journal entry.</p>
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
                            Sequential approval: Preparer → Reviewer → Authoriser. As the preparer you sign on submission;
                            select the reviewer and authoriser below.
                        </p>

                        {showApproverDropdown && <div className="fixed inset-0 z-10" onClick={() => setShowApproverDropdown(null)} />}

                        <div className="space-y-4">
                            {approvalRoles.map((role, index) => {
                                const selectedUserId = selectedApprovers[role.key];
                                const selectedUser = selectedUserId ? users.find(u => u.id === selectedUserId) : null;
                                const filteredUsers = getFilteredUsersForRole(role.key);
                                const isPreparer = role.key === 'preparer';

                                return (
                                    <div key={role.key} className="relative">
                                        <div className="flex items-start gap-4">
                                            <div className="w-10 h-10 rounded-full flex items-center justify-center border-2 bg-primary-50 border-primary-200 text-primary-600 flex-shrink-0 mt-1">
                                                <span className="font-bold text-sm">{index + 1}</span>
                                            </div>
                                            <div className="flex-1">
                                                <div className="mb-2 flex items-center gap-2 flex-wrap">
                                                    <h4 className="font-semibold text-gray-900">{role.label}</h4>
                                                    {isPreparer && (
                                                        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-50 text-amber-700 border border-amber-200 uppercase tracking-wide">You — pre-signed</span>
                                                    )}
                                                </div>
                                                <p className="text-xs text-gray-500 -mt-1 mb-2">{role.description}</p>
                                                {selectedUser ? (
                                                    <div className={`flex items-center gap-3 p-3 rounded-xl ${isPreparer ? 'bg-amber-50 border border-amber-200' : 'bg-primary-50 border border-primary-200'}`}>
                                                        <div className={`w-8 h-8 rounded-full ${isPreparer ? 'bg-amber-100' : 'bg-primary-100'} flex items-center justify-center flex-shrink-0`}>
                                                            <span className={`text-sm font-medium ${isPreparer ? 'text-amber-700' : 'text-primary-600'}`}>{selectedUser.display_name?.charAt(0)?.toUpperCase() || '?'}</span>
                                                        </div>
                                                        <div className="flex-1 min-w-0">
                                                            <p className="text-sm font-medium text-gray-900 truncate">{selectedUser.display_name}</p>
                                                            <p className="text-xs text-gray-500 truncate">{selectedUser.email}</p>
                                                            {isPreparer && <p className="text-xs text-amber-700 mt-0.5">Signs automatically on submission</p>}
                                                        </div>
                                                        {!isPreparer && (
                                                            <button
                                                                type="button"
                                                                onClick={() => handleRemoveApprover(role.key)}
                                                                className="p-1.5 rounded-lg hover:bg-danger-50 text-gray-400 hover:text-danger-500"
                                                                title="Change approver"
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

                {/* Fixed bottom action bar */}
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
                                <Button type="button" variant="secondary" onClick={() => setShowPreview(true)} disabled={loading || savingDraft}>Preview / Print PDF</Button>
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
                title="Journal Entry"
                subtitle={formData.referenceNo ? `Reference: ${formData.referenceNo}` : undefined}
                sections={buildPreviewSections()}
                documentHeader={JOURNAL_DOCUMENT_HEADER}
            />
            <RequestPreviewModal
                isOpen={showConfirm}
                onClose={() => setShowConfirm(false)}
                mode="confirm"
                title="Journal Entry"
                subtitle={formData.referenceNo ? `Reference: ${formData.referenceNo}` : undefined}
                sections={buildPreviewSections()}
                documentHeader={JOURNAL_DOCUMENT_HEADER}
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
