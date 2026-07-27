import { useSession } from 'next-auth/react';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import { AppLayout } from '../../../components/layout';
import { Card, Button, Input, RequestPreviewModal, UnsavedChangesModal, ReferenceCodeBanner } from '../../../components/ui';
import type { PreviewSection } from '../../../components/ui';
import { useCurrentUser } from '../../../hooks/useCurrentUser';
import { useUnsavedChangesPrompt, useFormAutosave } from '../../../hooks';
import { useUserHrimsProfile } from '../../../hooks/useUserHrimsProfile';
import { OnBehalfOfField, type OnBehalfOf } from '../../../components/requests/OnBehalfOfField';
import ApproverSectionLoader from '../../../components/requests/ApproverSectionLoader';
import { Span } from 'next/dist/trace';

interface SelectedBusinessUnit {
    id: string;
    name: string;
    bookingMade: boolean;
    voucherValidityPeriod: string;
    numberOfPeople: string;
    numberOfRooms: string;
    accommodationType: string;
    roomType: string;
    specialArrangements: string;
    numberOfMeals: string;
    mealPeopleCount: string;
}

interface SupportingDocument {
    file: File;
    label: string;
    description: string;
}

export default function VoucherRequestPage() {
    const { data: session, status } = useSession();
    const router = useRouter();
    const { user } = useCurrentUser();
    const { departmentName, businessUnitName } = useUserHrimsProfile();
    const [businessUnits, setBusinessUnits] = useState<Array<{ id: string; name: string }>>([]);
    const [businessUnitsLoading, setBusinessUnitsLoading] = useState(true);
    const [loading, setLoading] = useState(false);
    const [savingDraft, setSavingDraft] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [selectedBusinessUnits, setSelectedBusinessUnits] = useState<SelectedBusinessUnit[]>([]);
    const [supportingDocuments, setSupportingDocuments] = useState<SupportingDocument[]>([]);
    const [existingSupportingDocs, setExistingSupportingDocs] = useState<any[]>([]);

    // Edit mode state
    const { edit: editRequestId, approver: isApproverEdit } = router.query;
    const isEditMode = !!editRequestId;
    const isApproverEditing = isApproverEdit === 'true';
    const [loadingRequest, setLoadingRequest] = useState(false);
    const [originalFormData, setOriginalFormData] = useState<any>(null);
    const [originalTravelData, setOriginalTravelData] = useState<any>(null);
    const [originalBusinessUnits, setOriginalBusinessUnits] = useState<SelectedBusinessUnit[]>([]);
    const [originalApprovers, setOriginalApprovers] = useState<Record<string, string> | null>(null);
    const [requestStatus, setRequestStatus] = useState<string>('draft');
    const [referenceCode, setReferenceCode] = useState<string | null>(null);
    const [existingReferenceCode, setExistingReferenceCode] = useState<string | null>(null);

    const handleSupportingDocUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = e.target.files;
        if (files) {
            const newDocs: SupportingDocument[] = Array.from(files).map(file => ({
                file,
                label: '',
                description: '',
            }));
            setSupportingDocuments(prev => [...prev, ...newDocs]);
        }
    };

    const handleRemoveSupportingDoc = (index: number) => {
        setSupportingDocuments(prev => prev.filter((_, i) => i !== index));
    };

    const handleUpdateSupportingDoc = (index: number, field: keyof SupportingDocument, value: string) => {
        setSupportingDocuments(prev => prev.map((doc, i) => {
            if (i === index) {
                return { ...doc, [field]: value };
            }
            return doc;
        }));
    };

    // Initial date for display
    const today = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });

    // Today's date in ISO format for min date validation
    const todayISO = new Date().toISOString().split('T')[0];

    const [formData, setFormData] = useState({
        voucherNumber: '',
        guestNames: '',
        guestTitle: '',
        guestFirstName: '',
        showNameOnVoucher: true,
        isExternalGuest: false,
        allocationType: '',
        percentageDiscount: '',
        reason: '',
        processTravelDocument: false,
    });

    // Unsaved-changes tracking — flipped true on first real user interaction via form onChange.
    const [isDirty, setIsDirty] = useState(false);

    // Voucher numbers are issued sequentially by the server at final approval
    // (see approvalEngine.onVoucherFullyApproved), so none is generated here.

    // Approver selection state - 2 fixed roles
    const approvalRoles = [
        { key: 'commercial_director', label: 'Chief Commercial Officer', description: 'Commercial Approval' },
        { key: 'ceo', label: 'CEO', description: 'Final Authorization' },
    ];
    const [users, setUsers] = useState<Array<{ id: string; display_name: string; email: string; job_title?: string }>>([]);
    const [loadingUsers, setLoadingUsers] = useState(true);
    const [selectedApprovers, setSelectedApprovers] = useState<Record<string, string>>({
        commercial_director: '',
        ceo: '',
    });
    const [approverSearch, setApproverSearch] = useState<Record<string, string>>({
        commercial_director: '',
        ceo: '',
    });
    const [showApproverDropdown, setShowApproverDropdown] = useState<string | null>(null);
    const [loadingApproverResolution, setLoadingApproverResolution] = useState(!isEditMode);
    const [autoResolvedRoles, setAutoResolvedRoles] = useState<Record<string, boolean>>({});

    // Watchers state
    const [selectedWatchers, setSelectedWatchers] = useState<Array<{ id: string; display_name: string; email: string }>>([]);
    const [watcherSearch, setWatcherSearch] = useState('');
    const [onBehalfOf, setOnBehalfOf] = useState<OnBehalfOf | null>(null);
    const [showWatcherDropdown, setShowWatcherDropdown] = useState(false);

    // Autosave / crash recovery (serializable slices only). Disabled in edit mode.
    useFormAutosave({
        formKey: 'voucher',
        enabled: !isEditMode,
        data: { formData, selectedApprovers, selectedWatchers },
        onRestore: (saved) => {
            if (saved.formData) setFormData(saved.formData);
            if (saved.selectedApprovers) setSelectedApprovers(prev => ({ ...prev, ...saved.selectedApprovers }));
            if (Array.isArray(saved.selectedWatchers)) setSelectedWatchers(saved.selectedWatchers);
            setIsDirty(true);
        },
    });

    // Travel document state
    const [travelData, setTravelData] = useState({
        dateOfIntendedTravel: '',
        purposeOfTravel: '',
        accompanyingAssociates: '',
        travelMode: '',
        acceptConditions: false,
        itinerary: [{ date: '', from: '', to: '', km: '', justification: '' }],
        hotelReservation: '',
        budget: {
            fuel: { quantity: '', unitCost: '', totalCost: '' },
            aaRates: { quantity: '', unitCost: '', totalCost: '' },
            airBusTickets: { quantity: '', unitCost: '', totalCost: '' },
            overnightAccommodation: { quantity: '', unitCost: '', totalCost: '' },
            lunchDinner: { quantity: '', unitCost: '', totalCost: '' },
            conferencingCost: { quantity: '', unitCost: '', totalCost: '' },
            tollgates: [{ road: '', quantity: '1', unitCost: '', totalCost: '' }],
            other: { description: '', quantity: '', unitCost: '', totalCost: '' },
        },
    });

    const addItineraryRow = () => {
        setTravelData(prev => ({
            ...prev,
            itinerary: [...prev.itinerary, { date: '', from: '', to: '', km: '', justification: '' }]
        }));
    };

    const updateItineraryRow = (index: number, field: string, value: string) => {
        setTravelData(prev => ({
            ...prev,
            itinerary: prev.itinerary.map((row, i) =>
                i === index ? { ...row, [field]: value } : row
            )
        }));
    };

    const removeItineraryRow = (index: number) => {
        if (travelData.itinerary.length > 1) {
            setTravelData(prev => ({
                ...prev,
                itinerary: prev.itinerary.filter((_, i) => i !== index)
            }));
        }
    };

    // Calculate total tollgates cost
    const calculateTollgatesTotal = () => {
        return travelData.budget.tollgates.reduce((sum: number, t: any) => sum + (parseFloat(t.totalCost) || 0), 0);
    };

    const calculateGrandTotal = () => {
        const budget = travelData.budget;
        const tollgatesTotal = calculateTollgatesTotal();
        const values = [
            budget.aaRates.totalCost,
            budget.airBusTickets.totalCost,
            budget.conferencingCost.totalCost,
            budget.other.totalCost,
        ];
        return values.reduce((sum, val) => sum + (parseFloat(val) || 0), tollgatesTotal).toFixed(2);
    };

    const updateBudgetItem = (item: 'fuel' | 'aaRates' | 'airBusTickets' | 'overnightAccommodation' | 'lunchDinner' | 'conferencingCost' | 'other', field: string, value: string) => {
        setTravelData(prev => {
            const currentItem = prev.budget[item];
            const updatedItem = { ...currentItem, [field]: value };

            // Auto-calculate total cost when quantity or unit cost changes
            if (field === 'quantity' || field === 'unitCost') {
                const quantity = parseFloat(field === 'quantity' ? value : updatedItem.quantity) || 0;
                const unitCost = parseFloat(field === 'unitCost' ? value : updatedItem.unitCost) || 0;
                updatedItem.totalCost = (quantity * unitCost).toFixed(2);
            }

            return {
                ...prev,
                budget: {
                    ...prev.budget,
                    [item]: updatedItem,
                },
            };
        });
    };

    useEffect(() => {
        if (status === 'unauthenticated') {
            router.push('/');
        }
    }, [status, router]);

    // Fetch existing request data when in edit mode
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

                // Store original data for comparison
                setOriginalFormData({
                    voucherNumber: metadata.voucherNumber || '',
                    guestNames: metadata.guestNames || '',
                    guestTitle: metadata.guestTitle || '',
                    guestFirstName: metadata.guestFirstName || '',
                    showNameOnVoucher: metadata.showNameOnVoucher !== false,
                    isExternalGuest: metadata.isExternalGuest || false,
                    allocationType: metadata.allocationType || '',
                    percentageDiscount: metadata.percentageDiscount || '',
                    reason: metadata.reason || request.description || '',
                    processTravelDocument: metadata.processTravelDocument || false,
                });

                // Pre-fill form with existing data
                setFormData({
                    voucherNumber: metadata.voucherNumber || '',
                    guestNames: metadata.guestNames || '',
                    guestTitle: metadata.guestTitle || '',
                    guestFirstName: metadata.guestFirstName || '',
                    showNameOnVoucher: metadata.showNameOnVoucher !== false,
                    isExternalGuest: metadata.isExternalGuest || false,
                    allocationType: metadata.allocationType || '',
                    percentageDiscount: metadata.percentageDiscount || '',
                    reason: metadata.reason || request.description || '',
                    processTravelDocument: metadata.processTravelDocument || false,
                });

                // Set business units
                if (metadata.selectedBusinessUnits && Array.isArray(metadata.selectedBusinessUnits)) {
                    setSelectedBusinessUnits(metadata.selectedBusinessUnits);
                    setOriginalBusinessUnits(metadata.selectedBusinessUnits);
                }

                // Set travel data if present
                if (metadata.travelDocument) {
                    setTravelData(metadata.travelDocument);
                    setOriginalTravelData(metadata.travelDocument);
                }

                // Set approvers and store original for change tracking
                const approverRolesData = metadata.approverRoles || {};
                if (approverRolesData && typeof approverRolesData === 'object') {
                    setSelectedApprovers(prev => ({ ...prev, ...approverRolesData }));
                    setOriginalApprovers({ commercial_director: '', ceo: '', ...approverRolesData });
                }

                // Supporting documents
                if (metadata.supportingDocuments && Array.isArray(metadata.supportingDocuments)) {
                    setExistingSupportingDocs(metadata.supportingDocuments);
                } else if (request.documents && Array.isArray(request.documents) && request.documents.length > 0) {
                    const docsFromTable = request.documents.map((doc: any) => ({
                        name: doc.filename,
                        size: doc.file_size,
                        type: doc.mime_type,
                        label: doc.document_type || 'Supporting Document',
                        description: '',
                        documentId: doc.id,
                    }));
                    setExistingSupportingDocs(docsFromTable);
                }

                // Load watchers
                if (metadata.watchers && Array.isArray(metadata.watchers)) {
                    setSelectedWatchers(metadata.watchers);
                }
            } catch (err: any) {
                console.error('Error fetching request:', err);
                setError('Failed to load request data');
            } finally {
                setLoadingRequest(false);
            }
        };

        if (status === 'authenticated' && editRequestId) {
            fetchExistingRequest();
        }
    }, [editRequestId, status]);

    // Fetch business units
    useEffect(() => {
        const fetchBusinessUnits = async () => {
            try {
                const response = await fetch('/api/business-units');
                if (response.ok) {
                    const data = await response.json();
                    const fetchedUnits = data.businessUnits || [];
                    const filteredUnits = fetchedUnits.filter((u: any) => u.name.toLowerCase() !== 'head office');
                    setBusinessUnits([{ id: 'any', name: 'Any RTG Hotel of Choice' }, ...filteredUnits]);
                }
            } catch (err) {
                console.error('Failed to fetch business units:', err);
            } finally {
                setBusinessUnitsLoading(false);
            }
        };

        if (status === 'authenticated') {
            fetchBusinessUnits();
        }
    }, [status]);

    // Fetch users for approver selection
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

        if (status === 'authenticated') {
            fetchUsers();
        }
    }, [status]);

    // Auto-resolve approvers from HRIMS organogram (only on new requests, not edits)
    useEffect(() => {
        const resolveApprovers = async () => {
            if (!session?.user?.email || isEditMode) { setLoadingApproverResolution(false); return; }
            setLoadingApproverResolution(true);
            try {
                const response = await fetch(`/api/hrims/resolve-approvers?email=${encodeURIComponent(session.user.email)}&formType=voucher`);
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
                } else {
                    console.error('Approver resolution failed:', data.error || 'Unknown error');
                }
            } catch (err) {
                console.error('Failed to auto-resolve approvers:', err);
            } finally {
                setLoadingApproverResolution(false);
            }
        };
        if (status === 'authenticated') resolveApprovers();
    }, [status, session?.user?.email, isEditMode]);

    // Filter users by search for a specific role
    const getFilteredUsersForRole = (roleKey: string) => {
        const searchTerm = approverSearch[roleKey] || '';
        const alreadySelectedIds = Object.values(selectedApprovers).filter(id => id);
        // The requester can never approve their own request — hide themselves from the picker.
        const currentUserId = (session?.user as any)?.id;
        return users.filter(u => u.id !== currentUserId).filter(u => {
            const matchesSearch = searchTerm
                ? (u.display_name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
                    u.email?.toLowerCase().includes(searchTerm.toLowerCase()))
                : true;
            const notAlreadySelected = !alreadySelectedIds.includes(u.id) || selectedApprovers[roleKey] === u.id;
            return matchesSearch && notAlreadySelected;
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

    // Watcher helper functions
    const getFilteredUsersForWatchers = () => {
        const alreadySelectedIds = [
            ...selectedWatchers.map(w => w.id),
            ...Object.values(selectedApprovers).filter(Boolean),
            user?.id, // Exclude the creator
        ];
        return users.filter(u => {
            const matchesSearch = watcherSearch
                ? (u.display_name?.toLowerCase().includes(watcherSearch.toLowerCase()) ||
                    u.email?.toLowerCase().includes(watcherSearch.toLowerCase()))
                : true;
            const notAlreadySelected = !alreadySelectedIds.includes(u.id);
            return matchesSearch && notAlreadySelected;
        });
    };

    const handleSelectWatcher = (userId: string) => {
        const userToAdd = users.find(u => u.id === userId);
        if (userToAdd && !selectedWatchers.some(w => w.id === userId)) {
            setSelectedWatchers(prev => [...prev, {
                id: userToAdd.id,
                display_name: userToAdd.display_name,
                email: userToAdd.email,
            }]);
        }
        setWatcherSearch('');
        setShowWatcherDropdown(false);
    };

    const handleRemoveWatcher = (userId: string) => {
        setSelectedWatchers(prev => prev.filter(w => w.id !== userId));
    };

    const handleBusinessUnitToggle = (unitId: string, unitName: string) => {
        setSelectedBusinessUnits(prev => {
            const exists = prev.find(u => u.id === unitId);
            if (exists) {
                return prev.filter(u => u.id !== unitId);
            }
            if (unitId === 'any') {
                return [{
                    id: 'any',
                    name: 'Any RTG Hotel of Choice',
                    bookingMade: false,
                    voucherValidityPeriod: '',
                    numberOfPeople: '',
                    numberOfRooms: '',
                    accommodationType: 'accommodation_only',
                    roomType: '',
                    specialArrangements: 'N/A',
                    numberOfMeals: '',
                    mealPeopleCount: '',
                }];
            }
            return [...prev, {
                id: unitId,
                name: unitName,
                bookingMade: false,
                voucherValidityPeriod: '',
                numberOfPeople: '',
                numberOfRooms: '',
                accommodationType: 'accommodation_only',
                roomType: '',
                specialArrangements: 'N/A',
                numberOfMeals: '',
                mealPeopleCount: '',
            }];
        });
    };

    const handleBusinessUnitFieldChange = (unitId: string, field: keyof SelectedBusinessUnit, value: string | boolean) => {
        setSelectedBusinessUnits(prev =>
            prev.map(u => {
                if (u.id !== unitId) return u;
                return { ...u, [field]: value };
            })
        );
    };

    // Helper to get approver display name
    const getApproverName = (approverId: string) => {
        const user = users.find(u => u.id === approverId);
        return user ? user.display_name : approverId || 'None';
    };

    // Helper to collect field changes for approver edit tracking
    const collectFieldChanges = () => {
        if (!originalFormData) return [];
        const changes: { fieldName: string; oldValue: any; newValue: any }[] = [];

        if (formData.voucherNumber !== originalFormData.voucherNumber) {
            changes.push({ fieldName: 'voucherNumber', oldValue: originalFormData.voucherNumber, newValue: formData.voucherNumber });
        }
        if (formData.guestNames !== originalFormData.guestNames) {
            changes.push({ fieldName: 'guestNames', oldValue: originalFormData.guestNames, newValue: formData.guestNames });
        }
        if (formData.guestTitle !== originalFormData.guestTitle) {
            changes.push({ fieldName: 'guestTitle', oldValue: originalFormData.guestTitle, newValue: formData.guestTitle });
        }
        if (formData.guestFirstName !== originalFormData.guestFirstName) {
            changes.push({ fieldName: 'guestFirstName', oldValue: originalFormData.guestFirstName, newValue: formData.guestFirstName });
        }
        if (formData.showNameOnVoucher !== originalFormData.showNameOnVoucher) {
            changes.push({ fieldName: 'showNameOnVoucher', oldValue: originalFormData.showNameOnVoucher, newValue: formData.showNameOnVoucher });
        }
        if (formData.isExternalGuest !== originalFormData.isExternalGuest) {
            changes.push({ fieldName: 'isExternalGuest', oldValue: originalFormData.isExternalGuest, newValue: formData.isExternalGuest });
        }
        if (formData.allocationType !== originalFormData.allocationType) {
            changes.push({ fieldName: 'allocationType', oldValue: originalFormData.allocationType, newValue: formData.allocationType });
        }
        if (formData.percentageDiscount !== originalFormData.percentageDiscount) {
            changes.push({ fieldName: 'percentageDiscount', oldValue: originalFormData.percentageDiscount, newValue: formData.percentageDiscount });
        }
        if (formData.reason !== originalFormData.reason) {
            changes.push({ fieldName: 'reason', oldValue: originalFormData.reason, newValue: formData.reason });
        }
        if (JSON.stringify(selectedBusinessUnits) !== JSON.stringify(originalBusinessUnits)) {
            changes.push({ fieldName: 'selectedBusinessUnits', oldValue: JSON.stringify(originalBusinessUnits), newValue: JSON.stringify(selectedBusinessUnits) });
        }
        if (formData.processTravelDocument && originalTravelData && JSON.stringify(travelData) !== JSON.stringify(originalTravelData)) {
            changes.push({ fieldName: 'travelDocument', oldValue: JSON.stringify(originalTravelData), newValue: JSON.stringify(travelData) });
        }

        // Track approval workflow changes
        if (originalApprovers) {
            const roleLabels: Record<string, string> = {
                commercial_director: 'Commercial Director Approver',
                ceo: 'CEO Approver',
            };
            for (const role of Object.keys(roleLabels)) {
                const oldApprover = originalApprovers[role] || '';
                const newApprover = selectedApprovers[role] || '';
                if (oldApprover !== newApprover) {
                    changes.push({
                        fieldName: roleLabels[role],
                        oldValue: getApproverName(oldApprover),
                        newValue: getApproverName(newApprover),
                    });
                }
            }
        }

        return changes;
    };

    // Handle approver save (edit mode with change tracking)
    const handleApproverSave = async () => {
        setLoading(true);
        setError(null);

        try {
            const fieldChanges = collectFieldChanges();
            const approversArray = [selectedApprovers.commercial_director, selectedApprovers.ceo].filter(Boolean);

            const response = await fetch(`/api/requests/${editRequestId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title: `Voucher Request: ${formData.guestNames}`,
                    description: formData.reason,
                    metadata: {
                        type: 'voucher_request',
                        referenceCode: existingReferenceCode || referenceCode || undefined,
                        voucherNumber: formData.voucherNumber,
                        guestNames: formData.guestNames,
                        guestTitle: formData.guestTitle,
                        guestFirstName: formData.guestFirstName,
                        showNameOnVoucher: formData.showNameOnVoucher,
                        isExternalGuest: formData.isExternalGuest,
                        selectedBusinessUnits: selectedBusinessUnits,
                        allocationType: formData.allocationType,
                        percentageDiscount: formData.percentageDiscount,
                        reason: formData.reason,
                        processTravelDocument: formData.processTravelDocument,
                        ...(formData.processTravelDocument && { travelDocument: travelData }),
                        approvers: approversArray,
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
                    },
                }),
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || 'Failed to save changes');
            }

            // Record modifications if there are changes
            if (fieldChanges.length > 0) {
                await fetch(`/api/requests/${editRequestId}/approver-edit`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ fieldChanges }),
                });
            }

            // Upload new documents
            if (supportingDocuments.length > 0) {
                for (const doc of supportingDocuments) {
                    const uploadFormData = new FormData();
                    uploadFormData.append('file', doc.file);
                    uploadFormData.append('documentType', 'supporting');

                    try {
                        const endpoint = isApproverEditing
                            ? `/api/requests/${editRequestId}/approver-documents`
                            : `/api/requests/${editRequestId}/documents`;

                        await fetch(endpoint, {
                            method: 'POST',
                            body: uploadFormData,
                        });
                    } catch (uploadErr) {
                        console.error('Error uploading document:', uploadErr);
                    }
                }
            }

            router.push(`/requests/comp/${editRequestId}`);
        } catch (err: any) {
            setError(err.message || 'Failed to save changes');
        } finally {
            setLoading(false);
        }
    };

    // Handle draft owner save (edit mode)
    const handleDraftSave = async () => {
        setSavingDraft(true);
        setError(null);

        try {
            const approversArray = [selectedApprovers.commercial_director, selectedApprovers.ceo].filter(Boolean);

            const response = await fetch(`/api/requests/${editRequestId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title: `Voucher Request: ${formData.guestNames || 'Draft'}`,
                    description: formData.reason || 'Draft request',
                    metadata: {
                        type: 'voucher_request',
                        referenceCode: existingReferenceCode || referenceCode || undefined,
                        voucherNumber: formData.voucherNumber,
                        guestNames: formData.guestNames,
                        guestTitle: formData.guestTitle,
                        guestFirstName: formData.guestFirstName,
                        showNameOnVoucher: formData.showNameOnVoucher,
                        isExternalGuest: formData.isExternalGuest,
                        selectedBusinessUnits: selectedBusinessUnits,
                        allocationType: formData.allocationType,
                        percentageDiscount: formData.percentageDiscount,
                        reason: formData.reason,
                        processTravelDocument: formData.processTravelDocument,
                        ...(formData.processTravelDocument && { travelDocument: travelData }),
                        approvers: approversArray,
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
                    },
                }),
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || 'Failed to save draft');
            }

            // Upload new documents
            if (supportingDocuments.length > 0) {
                for (const doc of supportingDocuments) {
                    const uploadFormData = new FormData();
                    uploadFormData.append('file', doc.file);
                    uploadFormData.append('documentType', 'supporting');

                    try {
                        const endpoint = isApproverEditing
                            ? `/api/requests/${editRequestId}/approver-documents`
                            : `/api/requests/${editRequestId}/documents`;

                        await fetch(endpoint, {
                            method: 'POST',
                            body: uploadFormData,
                        });
                    } catch (uploadErr) {
                        console.error('Error uploading document:', uploadErr);
                    }
                }
            }

            router.push(`/requests/comp/${editRequestId}`);
        } catch (err: any) {
            setError(err.message || 'Failed to save draft');
        } finally {
            setSavingDraft(false);
        }
    };

    const [showPreview, setShowPreview] = useState(false);
    const [showConfirm, setShowConfirm] = useState(false);

    const buildPreviewSections = (): PreviewSection[] => [
        {
            title: 'Voucher Details',
            fields: [
                { label: 'Voucher Number', value: formData.voucherNumber },
                { label: 'Guest Title', value: formData.guestTitle || '—' },
                { label: 'Guest First Name', value: formData.guestFirstName || '—' },
                { label: 'Guest Name(s)', value: formData.guestNames, fullWidth: true },
                { label: 'Show name on voucher', value: formData.showNameOnVoucher ? 'Yes' : 'No' },
                { label: 'Allocation', value: formData.allocationType || '—' },
                { label: 'Discount %', value: formData.percentageDiscount || '—' },
                { label: 'Reason', value: formData.reason, fullWidth: true },
                { label: 'Process Travel Document', value: formData.processTravelDocument ? 'Yes' : 'No' },
            ],
        },
        {
            title: 'Approvers',
            fields: approvalRoles.map(r => ({
                label: r.label,
                value: users.find(u => u.id === selectedApprovers[r.key])?.display_name || 'Not selected',
            })),
        },
    ];

    const performSubmit = async () => {
        await doSubmit();
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();

        // If approver editing, use approver save
        if (isApproverEditing && isEditMode) {
            await handleApproverSave();
            return;
        }

        // If editing a draft, use draft save
        if (isEditMode && !isApproverEditing) {
            await handleDraftSave();
            return;
        }

        setShowConfirm(true);
    };

    const doSubmit = async () => {
        setLoading(true);
        setError(null);

        // Validation
        const errors: string[] = [];

        // Required: At least one business unit
        if (selectedBusinessUnits.length === 0) {
            errors.push('Please select at least one business unit');
        }

        if (!formData.allocationType) {
            errors.push('Please select a Charge To / Allocation option');
        }

        // Required: Business unit fields
        for (const unit of selectedBusinessUnits) {
            const isMealOnly = [
                'meals_all', 'rainbow_delights', 'breakfast_only', 'lunch_only', 'dinner_only'
            ].includes(unit.accommodationType);

            if (!isMealOnly) {
                if (!unit.voucherValidityPeriod) {
                    errors.push(`Voucher validity period is required for ${unit.name}`);
                }
                if (!unit.numberOfPeople) {
                    errors.push(`Number of people is required for ${unit.name}`);
                }
                if (!unit.numberOfRooms) {
                    errors.push(`Number of rooms is required for ${unit.name}`);
                }
                if (!unit.roomType) {
                    errors.push(`Room type is required for ${unit.name}`);
                }
            }
            if (!unit.accommodationType) {
                errors.push(`Accommodation type is required for ${unit.name}`);
            }
        }

        // Required: Reason for complimentary
        if (!formData.reason.trim()) {
            errors.push('Reason for complimentary is required');
        }

        // Required: All 2 approvers
        if (!selectedApprovers.commercial_director) {
            errors.push('Please select an approver for Commercial Director');
        }
        if (!selectedApprovers.ceo) {
            errors.push('Please select an approver for CEO');
        }

        // Validate dates are not in the past

        // If processTravelDocument is checked, validate travel fields
        if (formData.processTravelDocument) {
            if (!travelData.dateOfIntendedTravel) {
                errors.push('Date of intended travel is required');
            } else {
                const travelDate = new Date(travelData.dateOfIntendedTravel);
                const travelTodayDate = new Date();
                travelTodayDate.setHours(0, 0, 0, 0);
                if (travelDate < travelTodayDate) {
                    errors.push('Date of intended travel cannot be in the past');
                }
            }
            if (!travelData.purposeOfTravel.trim()) {
                errors.push('Purpose of travel is required');
            }
            if (!travelData.travelMode.trim()) {
                errors.push('Travel mode is required');
            }
            if (!travelData.acceptConditions) {
                errors.push('You must accept the travel conditions');
            }
            // At least one itinerary row with data
            const hasValidItinerary = travelData.itinerary.some(
                row => row.date || row.from || row.to
            );
            if (!hasValidItinerary) {
                errors.push('At least one travel itinerary row is required');
            }
            // At least one budget row with data
            const budget = travelData.budget;
            const tollgatesTotal = budget.tollgates.reduce((sum: number, t: any) => sum + (parseFloat(t.totalCost) || 0), 0);
            const hasValidBudget =
                (budget.aaRates.totalCost && parseFloat(budget.aaRates.totalCost) > 0) ||
                (budget.airBusTickets.totalCost && parseFloat(budget.airBusTickets.totalCost) > 0) ||
                (budget.conferencingCost.totalCost && parseFloat(budget.conferencingCost.totalCost) > 0) ||
                (tollgatesTotal > 0) ||
                (budget.other.totalCost && parseFloat(budget.other.totalCost) > 0);
            if (!hasValidBudget) {
                errors.push('At least one travel budget item is required');
            }
        }

        if (errors.length > 0) {
            setError(errors.join('. '));
            setLoading(false);
            return;
        }

        try {
            // Convert approvers object to ordered array for sequential approval
            // Order: Commercial Director -> CEO
            const approversArray = [
                selectedApprovers.commercial_director,
                selectedApprovers.ceo,
            ].filter(Boolean); // Remove any empty values

            const response = await fetch('/api/requests', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    title: `Voucher Request: ${formData.guestNames}`,
                    description: formData.reason,
                    priority: 'normal',
                    category: 'hotel',
                    requestType: 'voucher_request',
                    status: 'pending', // Submit for approval immediately
                    metadata: {
                        type: 'voucher_request',
                        referenceCode: existingReferenceCode || referenceCode || undefined,
                        voucherNumber: formData.voucherNumber,
                        guestNames: formData.guestNames,
                        guestTitle: formData.guestTitle,
                        guestFirstName: formData.guestFirstName,
                        showNameOnVoucher: formData.showNameOnVoucher,
                        isExternalGuest: formData.isExternalGuest,
                        selectedBusinessUnits: selectedBusinessUnits,
                        allocationType: formData.allocationType,
                        percentageDiscount: formData.percentageDiscount,
                        reason: formData.reason,
                        processTravelDocument: formData.processTravelDocument,
                        ...(formData.processTravelDocument && { travelDocument: travelData }),
                        approvers: approversArray, // Sequential array of approver IDs
                        approverRoles: selectedApprovers, // Keep original object for reference
                        useParallelApprovals: false,
                        onBehalfOf: onBehalfOf || null,
                        watchers: selectedWatchers, // Users who can view and generate voucher
                        supportingDocuments: supportingDocuments.map(doc => ({
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
                    },
                }),
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || 'Failed to create voucher request request');
            }

            const requestId = data.request.id;

            // Upload documents
            if (supportingDocuments.length > 0) {
                for (const doc of supportingDocuments) {
                    const uploadFormData = new FormData();
                    uploadFormData.append('file', doc.file);
                    uploadFormData.append('documentType', 'supporting');

                    try {
                        await fetch(`/api/requests/${requestId}/documents`, {
                            method: 'POST',
                            body: uploadFormData,
                        });
                    } catch (uploadErr) {
                        console.error('Error uploading document:', uploadErr);
                    }
                }
            }

            router.push(`/requests/comp/${requestId}`);
        } catch (err: any) {
            setError(err.message || 'Failed to create voucher request request');
        } finally {
            setLoading(false);
        }
    };

    const handleSaveDraft = async () => {
        setSavingDraft(true);
        setError(null);

        try {
            // Convert approvers object to ordered array for sequential approval
            // Order: Commercial Director -> CEO
            const approversArray = [
                selectedApprovers.commercial_director,
                selectedApprovers.ceo,
            ].filter(Boolean);

            const response = await fetch('/api/requests', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    title: `Voucher Request: ${formData.guestNames || 'Draft'}`,
                    description: formData.reason || 'Draft request',
                    priority: 'normal',
                    category: 'hotel',
                    requestType: 'voucher_request',
                    status: 'draft',
                    metadata: {
                        type: 'voucher_request',
                        referenceCode: existingReferenceCode || referenceCode || undefined,
                        voucherNumber: formData.voucherNumber,
                        guestNames: formData.guestNames,
                        guestTitle: formData.guestTitle,
                        guestFirstName: formData.guestFirstName,
                        showNameOnVoucher: formData.showNameOnVoucher,
                        isExternalGuest: formData.isExternalGuest,
                        selectedBusinessUnits: selectedBusinessUnits,
                        allocationType: formData.allocationType,
                        percentageDiscount: formData.percentageDiscount,
                        reason: formData.reason,
                        processTravelDocument: formData.processTravelDocument,
                        ...(formData.processTravelDocument && { travelDocument: travelData }),
                        approvers: approversArray,
                        approverRoles: selectedApprovers,
                        useParallelApprovals: false,
                        onBehalfOf: onBehalfOf || null,
                        watchers: selectedWatchers,
                        supportingDocuments: supportingDocuments.map(doc => ({
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
                    },
                }),
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || 'Failed to save draft');
            }

            const requestId = data.request.id;

            // Upload documents
            if (supportingDocuments.length > 0) {
                for (const doc of supportingDocuments) {
                    const uploadFormData = new FormData();
                    uploadFormData.append('file', doc.file);
                    uploadFormData.append('documentType', 'supporting');

                    try {
                        await fetch(`/api/requests/${requestId}/documents`, {
                            method: 'POST',
                            body: uploadFormData,
                        });
                    } catch (uploadErr) {
                        console.error('Error uploading document:', uploadErr);
                    }
                }
            }

            router.push(`/requests/comp/${requestId}`);
        } catch (err: any) {
            setError(err.message || 'Failed to save draft');
        } finally {
            setSavingDraft(false);
        }
    };

    const unsavedPrompt = useUnsavedChangesPrompt({
        isDirty,
        disabled: loading || savingDraft,
    });

    if (status === 'loading' || loadingRequest) {
        return (
            <AppLayout title="Voucher Request" showBack onBack={() => router.back()}>
                <div className="flex items-center justify-center min-h-[60vh]">
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-500" />
                </div>
            </AppLayout>
        );
    }

    if (!session) return null;

    const pageTitle = isApproverEditing ? 'Edit Voucher Request (Approver)' : isEditMode ? 'Edit Voucher Request' : 'Voucher Request';

    return (
        <AppLayout title={pageTitle} showBack onBack={() => router.back()} hideNav>
            <form onSubmit={handleSubmit} onChange={() => setIsDirty(true)} className="p-4 sm:p-6 max-w-5xl mx-auto pb-32">
                <div className="mb-6 text-center">
                    <h1 className="text-2xl font-bold text-text-primary font-heading uppercase tracking-wide">
                        {isApproverEditing ? 'Edit Voucher Request' : 'Complimentary Voucher Request Form'}
                    </h1>
                    <div className="mt-4 max-w-lg mx-auto">
                        <ReferenceCodeBanner
                            requestType="voucher_request"
                            existingCode={existingReferenceCode}
                            onCodeAssigned={setReferenceCode}
                        />
                    </div>
                    {isApproverEditing && (
                        <div className="mt-3 inline-flex items-center gap-2 px-4 py-2 bg-primary-50 border border-primary-200 rounded-xl">
                            <svg className="w-4 h-4 text-primary-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                            </svg>
                            <span className="text-sm font-medium text-primary-700">Editing as Approver - Changes will be tracked</span>
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

                    {/* Requestor Information Section */}
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
                            <div>
                                <label className="block text-sm font-semibold text-gray-700 mb-1 uppercase">Voucher Number</label>
                                <div className="px-4 py-2 rounded-xl border border-gray-200 bg-gray-50 text-gray-500 text-sm italic">
                                    {formData.voucherNumber || 'Assigned automatically on final approval'}
                                </div>
                            </div>
                        </div>
                    </Card>

                    {/* Guest Section */}
                    <Card className="p-6">
                        <h3 className="text-sm font-semibold text-gray-700 mb-4 uppercase border-b pb-2">Guest Information</h3>
                        <div className="space-y-6">
                            <div>
                                <label className="block text-sm font-semibold text-gray-700 mb-1 uppercase">Name of Guest / Company</label>
                                <textarea
                                    className="w-full px-4 py-3 rounded-xl border border-gray-300 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none transition-all resize-none min-h-[80px]"
                                    placeholder="Enter full names of all guests"
                                    value={formData.guestNames}
                                    onChange={(e) => setFormData({ ...formData, guestNames: e.target.value })}
                                   
                                />
                            </div>

                            {/* Personalization Section */}
                            <div className="bg-gray-50 rounded-xl p-4 border border-gray-200">
                                <div className="flex items-center gap-3 mb-4">
                                    <input
                                        type="checkbox"
                                        id="showNameOnVoucher"
                                        checked={formData.showNameOnVoucher}
                                        onChange={(e) => setFormData({ ...formData, showNameOnVoucher: e.target.checked })}
                                        className="w-5 h-5 text-primary-600 focus:ring-primary-500 border-gray-300 rounded cursor-pointer"
                                    />
                                    <label htmlFor="showNameOnVoucher" className="text-sm text-gray-700 cursor-pointer font-medium hover:text-gray-900">
                                        Personalize voucher with guest name greeting
                                    </label>
                                </div>
                                
                                {formData.showNameOnVoucher && (
                                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-4 pt-4 border-t border-gray-200">
                                        <div>
                                            <label className="block text-sm font-semibold text-gray-700 mb-1 uppercase">Title</label>
                                            <div className="relative">
                                                <select
                                                    className="w-full px-4 py-3 rounded-xl border border-gray-300 bg-white focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none transition-all appearance-none pr-10"
                                                    value={formData.guestTitle}
                                                    onChange={(e) => setFormData({ ...formData, guestTitle: e.target.value })}
                                                >
                                                    <option value="">Select Title</option>
                                                    <option value="Mr.">Mr.</option>
                                                    <option value="Mrs.">Mrs.</option>
                                                    <option value="Ms.">Ms.</option>
                                                    <option value="Dr.">Dr.</option>
                                                    <option value="Prof.">Prof.</option>
                                                    <option value="Hon.">Hon.</option>
                                                    <option value="Rev.">Rev.</option>
                                                </select>
                                                <div className="absolute inset-y-0 right-0 flex items-center px-4 pointer-events-none text-gray-500">
                                                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7"></path></svg>
                                                </div>
                                            </div>
                                        </div>
                                        <div className="md:col-span-2">
                                            <label className="block text-sm font-semibold text-gray-700 mb-1 uppercase">Guest Name (for greeting)</label>
                                            <input
                                                type="text"
                                                className="w-full px-4 py-3 rounded-xl border border-gray-300 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none transition-all"
                                                placeholder="e.g. John Smith"
                                                value={formData.guestFirstName}
                                                onChange={(e) => setFormData({ ...formData, guestFirstName: e.target.value })}
                                            />
                                        </div>
                                        <div className="md:col-span-3">
                                            <p className="text-xs text-gray-500 italic">
                                                The voucher will be addressed as: &ldquo;Dear {formData.guestTitle || '[Title]'} {formData.guestFirstName || '[Name]'}&rdquo;
                                            </p>
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                    </Card>

                    {/* Business Units Selection */}
                    <Card className="p-6">
                        <h3 className="text-sm font-semibold text-gray-700 mb-4 uppercase border-b pb-2">Select Business Units <span className="text-danger-500">*</span></h3>
                        <p className="text-sm text-gray-500 mb-4">Select at least one option. Each option has its own details.</p>
                        <div className="space-y-4">
                            {(selectedBusinessUnits.some(u => u.id === 'any') ? businessUnits.filter(u => u.id === 'any') : businessUnits).map((unit) => {
                                const isSelected = selectedBusinessUnits.some(u => u.id === unit.id);
                                const selectedUnit = selectedBusinessUnits.find(u => u.id === unit.id);
                                return (
                                    <div
                                        key={unit.id}
                                        className={`rounded-xl border transition-all ${isSelected
                                            ? 'border-primary-300 bg-primary-50/50'
                                            : 'border-gray-200 bg-white hover:border-gray-300'
                                            }`}
                                    >
                                        <div className="p-4">
                                            <div className="flex items-center justify-between flex-wrap gap-4">
                                                <label className="flex items-center gap-3 cursor-pointer flex-1 min-w-[200px]">
                                                    <input
                                                        type="checkbox"
                                                        checked={isSelected}
                                                        onChange={() => handleBusinessUnitToggle(unit.id, unit.name)}
                                                        className="w-5 h-5 text-primary-600 focus:ring-primary-500 border-gray-300 rounded"
                                                    />
                                                    <span className="font-semibold text-gray-900">{unit.name}</span>
                                                </label>
                                                {isSelected}
                                            </div>
                                        </div>

                                        {isSelected && selectedUnit && (() => {
                                            const isMealOnly = ['meals_all', 'rainbow_delights', 'breakfast_only', 'lunch_only', 'dinner_only'].includes(selectedUnit.accommodationType);
                                            return (
                                                <div className="border-t border-primary-200 bg-white p-4 rounded-b-xl space-y-4">
                                                    <div>
                                                        <label className="block text-sm font-semibold text-gray-700 mb-2 uppercase">Voucher Type <span className="text-danger-500">*</span></label>
                                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                                                            <label className="flex items-center gap-2 cursor-pointer p-2 rounded-lg hover:bg-gray-50 border border-transparent hover:border-gray-200">
                                                                <input
                                                                    type="radio"
                                                                    name={`accommodationType_${unit.id}`}
                                                                    value="accommodation_only"
                                                                    checked={selectedUnit.accommodationType === 'accommodation_only'}
                                                                    onChange={(e) => handleBusinessUnitFieldChange(unit.id, 'accommodationType', e.target.value)}
                                                                    className="w-4 h-4 text-primary-600 focus:ring-primary-500 border-gray-300"
                                                                />
                                                                <span className="text-sm text-gray-700">Accommodation Only (Bed only)</span>
                                                            </label>
                                                            <label className="flex items-center gap-2 cursor-pointer p-2 rounded-lg hover:bg-gray-50 border border-transparent hover:border-gray-200">
                                                                <input
                                                                    type="radio"
                                                                    name={`accommodationType_${unit.id}`}
                                                                    value="accommodation_and_breakfast"
                                                                    checked={selectedUnit.accommodationType === 'accommodation_and_breakfast'}
                                                                    onChange={(e) => handleBusinessUnitFieldChange(unit.id, 'accommodationType', e.target.value)}
                                                                    className="w-4 h-4 text-primary-600 focus:ring-primary-500 border-gray-300"
                                                                />
                                                                <span className="text-sm text-gray-700">Bed & Breakfast Only</span>
                                                            </label>
                                                            <label className="flex items-center gap-2 cursor-pointer p-2 rounded-lg hover:bg-gray-50 border border-transparent hover:border-gray-200">
                                                                <input
                                                                    type="radio"
                                                                    name={`accommodationType_${unit.id}`}
                                                                    value="accommodation_and_meals"
                                                                    checked={selectedUnit.accommodationType === 'accommodation_and_meals'}
                                                                    onChange={(e) => handleBusinessUnitFieldChange(unit.id, 'accommodationType', e.target.value)}
                                                                    className="w-4 h-4 text-primary-600 focus:ring-primary-500 border-gray-300"
                                                                />
                                                                <span className="text-sm text-gray-700">Accommodation & Meals (Breakfast, Lunch, and Dinner)</span>
                                                            </label>
                                                            <label className="flex items-center gap-2 cursor-pointer p-2 rounded-lg hover:bg-gray-50 border border-transparent hover:border-gray-200">
                                                                <input
                                                                    type="radio"
                                                                    name={`accommodationType_${unit.id}`}
                                                                    value="accommodation_meals_drink"
                                                                    checked={selectedUnit.accommodationType === 'accommodation_meals_drink'}
                                                                    onChange={(e) => handleBusinessUnitFieldChange(unit.id, 'accommodationType', e.target.value)}
                                                                    className="w-4 h-4 text-primary-600 focus:ring-primary-500 border-gray-300"
                                                                />
                                                                <span className="text-sm text-gray-700">Accommodation, Meals plus a Soft Drink / Juice</span>
                                                            </label>
                                                            <label className="flex items-center gap-2 cursor-pointer p-2 rounded-lg hover:bg-gray-50 border border-transparent hover:border-gray-200">
                                                                <input
                                                                    type="radio"
                                                                    name={`accommodationType_${unit.id}`}
                                                                    value="meals_all"
                                                                    checked={selectedUnit.accommodationType === 'meals_all'}
                                                                    onChange={(e) => handleBusinessUnitFieldChange(unit.id, 'accommodationType', e.target.value)}
                                                                    className="w-4 h-4 text-primary-600 focus:ring-primary-500 border-gray-300"
                                                                />
                                                                <span className="text-sm text-gray-700">Meals (Breakfast, Lunch and Dinner Only)</span>
                                                            </label>
                                                            <label className="flex items-center gap-2 cursor-pointer p-2 rounded-lg hover:bg-gray-50 border border-transparent hover:border-gray-200">
                                                                <input
                                                                    type="radio"
                                                                    name={`accommodationType_${unit.id}`}
                                                                    value="rainbow_delights"
                                                                    checked={selectedUnit.accommodationType === 'rainbow_delights'}
                                                                    onChange={(e) => handleBusinessUnitFieldChange(unit.id, 'accommodationType', e.target.value)}
                                                                    className="w-4 h-4 text-primary-600 focus:ring-primary-500 border-gray-300"
                                                                />
                                                                <span className="text-sm text-gray-700">Rainbow Delights Meal(s) Only</span>
                                                            </label>
                                                            <label className="flex items-center gap-2 cursor-pointer p-2 rounded-lg hover:bg-gray-50 border border-transparent hover:border-gray-200">
                                                                <input
                                                                    type="radio"
                                                                    name={`accommodationType_${unit.id}`}
                                                                    value="breakfast_only"
                                                                    checked={selectedUnit.accommodationType === 'breakfast_only'}
                                                                    onChange={(e) => handleBusinessUnitFieldChange(unit.id, 'accommodationType', e.target.value)}
                                                                    className="w-4 h-4 text-primary-600 focus:ring-primary-500 border-gray-300"
                                                                />
                                                                <span className="text-sm text-gray-700">Breakfast meal(s) only</span>
                                                            </label>
                                                            <label className="flex items-center gap-2 cursor-pointer p-2 rounded-lg hover:bg-gray-50 border border-transparent hover:border-gray-200">
                                                                <input
                                                                    type="radio"
                                                                    name={`accommodationType_${unit.id}`}
                                                                    value="lunch_only"
                                                                    checked={selectedUnit.accommodationType === 'lunch_only'}
                                                                    onChange={(e) => handleBusinessUnitFieldChange(unit.id, 'accommodationType', e.target.value)}
                                                                    className="w-4 h-4 text-primary-600 focus:ring-primary-500 border-gray-300"
                                                                />
                                                                <span className="text-sm text-gray-700">Lunch meal(s) only</span>
                                                            </label>
                                                            <label className="flex items-center gap-2 cursor-pointer p-2 rounded-lg hover:bg-gray-50 border border-transparent hover:border-gray-200">
                                                                <input
                                                                    type="radio"
                                                                    name={`accommodationType_${unit.id}`}
                                                                    value="dinner_only"
                                                                    checked={selectedUnit.accommodationType === 'dinner_only'}
                                                                    onChange={(e) => handleBusinessUnitFieldChange(unit.id, 'accommodationType', e.target.value)}
                                                                    className="w-4 h-4 text-primary-600 focus:ring-primary-500 border-gray-300"
                                                                />
                                                                <span className="text-sm text-gray-700">Dinner meal(s) only</span>
                                                            </label>
                                                        </div>
                                                    </div>

                                                    {!isMealOnly && (
                                                        <>
                                                            <div className="mt-4">
                                                                <label className="block text-sm font-semibold text-gray-700 mb-2 uppercase">Room Type <span className="text-danger-500">*</span></label>
                                                                <div className="relative">
                                                                    <select
                                                                        className="w-full px-4 py-3 rounded-xl border border-gray-300 bg-white focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none transition-all appearance-none pr-10"
                                                                        value={selectedUnit.roomType}
                                                                        onChange={(e) => handleBusinessUnitFieldChange(unit.id, 'roomType', e.target.value)}
                                                                        required
                                                                    >
                                                                        <option value="" disabled>Select Room Type</option>
                                                                        <option value="Double room">Double room</option>
                                                                        <option value="Twin room">Twin room</option>
                                                                        <option value="Executive suite">Executive suite</option>
                                                                        <option value="Diplomatic suite">Diplomatic suite</option>
                                                                        <option value="Presidential suite">Presidential suite</option>
                                                                    </select>
                                                                    <div className="absolute inset-y-0 right-0 flex items-center px-4 pointer-events-none text-gray-500">
                                                                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7"></path></svg>
                                                                    </div>
                                                                </div>
                                                            </div>

                                                            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-6">
                                                                <div>
                                                                    <label className="block text-sm font-semibold text-gray-700 mb-1 uppercase">Validity Period <span className="text-danger-500">*</span></label>
                                                                    <div className="relative">
                                                                        <select
                                                                            className="w-full px-4 py-3 rounded-xl border border-gray-300 bg-white focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none transition-all appearance-none pr-10"
                                                                            value={selectedUnit.voucherValidityPeriod}
                                                                            onChange={(e) => handleBusinessUnitFieldChange(unit.id, 'voucherValidityPeriod', e.target.value)}
                                                                            required
                                                                        >
                                                                            <option value="" disabled>Select Period</option>
                                                                            <option value="1 month">1 month</option>
                                                                            <option value="3 months">3 months</option>
                                                                            <option value="6 months">6 months</option>
                                                                            <option value="9 months">9 months</option>
                                                                            <option value="12 months">12 months</option>
                                                                        </select>
                                                                        <div className="absolute inset-y-0 right-0 flex items-center px-4 pointer-events-none text-gray-500">
                                                                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7"></path></svg>
                                                                        </div>
                                                                    </div>
                                                                </div>
                                                                <Input
                                                                    type="number"
                                                                    label="No. Of People *"
                                                                    value={selectedUnit.numberOfPeople}
                                                                    onChange={(e) => handleBusinessUnitFieldChange(unit.id, 'numberOfPeople', e.target.value)}
                                                                    required
                                                                    min="1"
                                                                />
                                                                <Input
                                                                    type="number"
                                                                    label="No. Of Nights *"
                                                                    value={selectedUnit.numberOfRooms}
                                                                    onChange={(e) => handleBusinessUnitFieldChange(unit.id, 'numberOfRooms', e.target.value)}
                                                                    required
                                                                    min="1"
                                                                />
                                                            </div>
                                                        </>
                                                    )}

                                                    {/* Meal Options - shown for voucher types that include meals */}
                                                    {['meals_all', 'rainbow_delights', 'breakfast_only', 'lunch_only', 'dinner_only', 'accommodation_and_meals', 'accommodation_meals_drink'].includes(selectedUnit.accommodationType) && (
                                                        <div className="mt-4 p-4 bg-gray-50 border border-gray-200 rounded-xl">
                                                            <h4 className="text-sm font-semibold text-gray-700 mb-3 uppercase">Meal Details</h4>
                                                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                                                <div>
                                                                    <label className="block text-sm font-semibold text-gray-700 mb-1 uppercase">Number of Meals <span className="text-danger-500">*</span></label>
                                                                    <input
                                                                        type="number"
                                                                        className="w-full px-4 py-3 rounded-xl border border-gray-300 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none transition-all"
                                                                        placeholder="e.g. 2"
                                                                        value={selectedUnit.numberOfMeals}
                                                                        onChange={(e) => handleBusinessUnitFieldChange(unit.id, 'numberOfMeals', e.target.value)}
                                                                        min="1"
                                                                        required
                                                                    />
                                                                </div>
                                                                <div>
                                                                    <label className="block text-sm font-semibold text-gray-700 mb-1 uppercase">Number of People for Meals <span className="text-danger-500">*</span></label>
                                                                    <input
                                                                        type="number"
                                                                        className="w-full px-4 py-3 rounded-xl border border-gray-300 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none transition-all"
                                                                        placeholder="e.g. 4"
                                                                        value={selectedUnit.mealPeopleCount}
                                                                        onChange={(e) => handleBusinessUnitFieldChange(unit.id, 'mealPeopleCount', e.target.value)}
                                                                        min="1"
                                                                        required
                                                                    />
                                                                </div>
                                                            </div>
                                                            <p className="text-xs text-gray-500 mt-3 italic">
                                                                This voucher will entitle {selectedUnit.mealPeopleCount || '[X]'} person(s) to {selectedUnit.numberOfMeals || '[X]'} meal(s) at {unit.name}.
                                                            </p>
                                                        </div>
                                                    )}

                                                    <div>
                                                        <label className="block text-sm font-semibold text-gray-700 mb-1 uppercase">Special Arrangements</label>
                                                        <textarea
                                                            className="w-full px-4 py-2 rounded-xl border border-gray-300 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none transition-all resize-none min-h-[60px]"
                                                            value={selectedUnit.specialArrangements}
                                                            onChange={(e) => handleBusinessUnitFieldChange(unit.id, 'specialArrangements', e.target.value)}
                                                            placeholder="Any special arrangements..."
                                                        />
                                                    </div>
                                                </div>
                                            );
                                        })()}
                                    </div>
                                );
                            })}
                            {businessUnitsLoading && (
                                <div className="text-center py-8 text-gray-500">
                                    <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary-500 mx-auto mb-2" />
                                    <p>Loading business units...</p>
                                </div>
                            )}
                            {!businessUnitsLoading && businessUnits.length === 0 && (
                                <div className="text-center py-8 text-gray-500">
                                    <p>No business units available.</p>
                                </div>
                            )}
                        </div>
                    </Card>

                    {/* Allocation */}
                    <Card className="p-6">
                        <label className="block text-sm font-semibold text-gray-700 mb-3 uppercase">Charge to: <span className="text-danger-500">*</span></label>
                        <div className="relative">
                            <select
                                className="w-full px-4 py-3 rounded-xl border border-gray-300 bg-white focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none transition-all appearance-none pr-10"
                                value={formData.allocationType}
                                onChange={(e) => setFormData({ ...formData, allocationType: e.target.value })}
                                required
                            >
                                <option value="" disabled className='text-gray-500'>Select Department to charge to...</option>
                                <option value="Corporate Affairs and Quality">Corporate Affairs and Quality</option>
                                <option value="Commercial">Commercial</option>
                                <option value="Sales and Marketing">Sales and Marketing</option>
                                <option value="Front Office">Front Office</option>
                            </select>
                            <div className="absolute inset-y-0 right-0 flex items-center px-4 pointer-events-none text-gray-500">
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7"></path></svg>
                            </div>
                        </div>
                        <span className="p-6 space-y-6"></span>
                        <div>
                            <label className="block text-sm font-semibold text-gray-700 mb-1 uppercase">Reason for complimentary <span className="text-danger-500">*</span></label>
                            <textarea
                                className="w-full px-4 py-3 rounded-xl border border-gray-300 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none transition-all resize-none min-h-[80px]"
                                value={formData.reason}
                                onChange={(e) => setFormData({ ...formData, reason: e.target.value })}
                            />
                        </div>
                    </Card>

                    {/* Supporting Documents Section */}
                    <Card className="p-6">
                        <div className="flex justify-between items-center mb-4 border-b pb-2">
                            <h3 className="text-sm font-semibold text-gray-700 uppercase">Supporting Documents (Optional)</h3>
                            <div>
                                <input
                                    type="file"
                                    multiple
                                    onChange={handleSupportingDocUpload}
                                    className="hidden"
                                    id="supporting-docs-upload"
                                />
                                <label
                                    htmlFor="supporting-docs-upload"
                                    className="cursor-pointer inline-flex items-center gap-2 px-4 py-2 bg-primary-50 text-primary-700 rounded-xl hover:bg-primary-100 transition-colors text-sm font-medium border border-primary-200"
                                >
                                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4v16m8-8H4" />
                                    </svg>
                                    Add Documents
                                </label>
                            </div>
                        </div>

                        {existingSupportingDocs.length === 0 && supportingDocuments.length === 0 ? (
                            <div className="text-center py-8 bg-gray-50 rounded-xl border border-dashed border-gray-300">
                                <svg className="w-12 h-12 text-gray-400 mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 13h6m-3-3v6m5 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                                </svg>
                                <p className="text-gray-500 font-medium text-sm">No supporting documents attached</p>
                                <p className="text-gray-400 text-xs mt-1">Click the button above to upload files</p>
                            </div>
                        ) : (
                            <div className="space-y-4">
                                {existingSupportingDocs.map((doc, index) => (
                                    <div key={`existing-doc-${index}`} className="flex flex-col sm:flex-row gap-4 p-4 border border-gray-200 rounded-xl bg-gray-50">
                                        <div className="w-12 h-12 bg-white border border-gray-200 rounded-lg flex items-center justify-center flex-shrink-0">
                                            <svg className="w-6 h-6 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                                            </svg>
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <p className="text-sm font-semibold text-gray-900 truncate" title={doc.name}>{doc.name}</p>
                                            <p className="text-xs text-gray-500 mt-0.5">{((doc.size || 0) / 1024 / 1024).toFixed(2)} MB • Existing Document</p>
                                            {(doc.label || doc.description) && (
                                                <div className="mt-2 text-sm text-gray-700 bg-white p-2 rounded-lg border border-gray-100">
                                                    {doc.label && <p><span className="font-semibold text-gray-900">Label:</span> {doc.label}</p>}
                                                    {doc.description && <p><span className="font-semibold text-gray-900">Description:</span> {doc.description}</p>}
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                ))}

                                {supportingDocuments.map((doc, index) => (
                                    <div key={`new-doc-${index}`} className="flex flex-col sm:flex-row gap-4 p-4 border border-primary-100 rounded-xl bg-white shadow-sm hover:shadow-md transition-shadow">
                                        <div className="w-12 h-12 bg-primary-50 rounded-lg flex items-center justify-center flex-shrink-0 text-primary-600">
                                            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                                            </svg>
                                        </div>
                                        <div className="flex-1 space-y-3 min-w-0">
                                            <div className="flex items-start justify-between gap-4">
                                                <div className="min-w-0 flex-1">
                                                    <p className="text-sm font-semibold text-gray-900 truncate" title={doc.file.name}>{doc.file.name}</p>
                                                    <p className="text-xs text-gray-500 mt-0.5">{(doc.file.size / 1024 / 1024).toFixed(2)} MB</p>
                                                </div>
                                                <button
                                                    type="button"
                                                    onClick={() => handleRemoveSupportingDoc(index)}
                                                    className="p-1.5 rounded-lg text-gray-400 hover:text-danger-500 hover:bg-danger-50 transition-colors flex-shrink-0"
                                                    title="Remove document"
                                                >
                                                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" />
                                                    </svg>
                                                </button>
                                            </div>
                                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                                <div>
                                                    <label className="block text-xs font-semibold text-gray-700 mb-1 uppercase">Label</label>
                                                    <input
                                                        type="text"
                                                        value={doc.label}
                                                        onChange={(e) => handleUpdateSupportingDoc(index, 'label', e.target.value)}
                                                        placeholder="e.g. Invoice, Quote, ID..."
                                                        className="w-full px-3 py-2 rounded-lg border border-gray-300 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none transition-all text-sm"
                                                    />
                                                </div>
                                                <div>
                                                    <label className="block text-xs font-semibold text-gray-700 mb-1 uppercase">Description</label>
                                                    <input
                                                        type="text"
                                                        value={doc.description}
                                                        onChange={(e) => handleUpdateSupportingDoc(index, 'description', e.target.value)}
                                                        placeholder="Brief details about this file..."
                                                        className="w-full px-3 py-2 rounded-lg border border-gray-300 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none transition-all text-sm"
                                                    />
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </Card>
                    {/* Approval Section - 2 Fixed Roles */}
                    <Card className="p-6">
                        <h3 className="text-xl font-bold text-gray-900 mb-2 font-heading">Approval Workflow</h3>
                        <p className="text-sm text-gray-500 mb-6">
                            Approvers are automatically assigned from the HRIMS organogram. If a role has no assigned user, you must manually select one.
                        </p>

                        {loadingApproverResolution && <ApproverSectionLoader rows={approvalRoles.length} />}

                        {/* Click outside to close any dropdown */}
                        {showApproverDropdown && (
                            <div
                                className="fixed inset-0 z-10"
                                onClick={() => setShowApproverDropdown(null)}
                            />
                        )}

                        {/* Approval Roles */}
                        <div className={`space-y-4 ${loadingApproverResolution ? 'hidden' : ''}`}>
                            {approvalRoles.map((role, index) => {
                                const selectedUserId = selectedApprovers[role.key];
                                const selectedUser = selectedUserId ? users.find(u => u.id === selectedUserId) : null;
                                const filteredUsers = getFilteredUsersForRole(role.key);
                                const isAutoResolved = autoResolvedRoles[role.key];

                                return (
                                    <div key={role.key} className="relative">
                                        <div className="flex items-start gap-4">
                                            {/* Step Number */}
                                            <div className="w-10 h-10 rounded-full flex items-center justify-center border-2 bg-primary-50 border-primary-200 text-primary-600 flex-shrink-0 mt-1">
                                                <span className="font-bold text-sm">{index + 1}</span>
                                            </div>

                                            <div className="flex-1">
                                                {/* Role Label */}
                                                <div className="mb-2">
                                                    <h4 className="font-semibold text-gray-900">{role.label}</h4>
                                                    <p className="text-xs text-gray-500">{role.description}</p>
                                                </div>

                                                {/* Selected User or Search Input */}
                                                {selectedUser ? (
                                                    <div className={`flex items-center gap-3 ${isAutoResolved ? 'bg-green-50 border border-green-200' : 'bg-primary-50 border border-primary-200'} p-3 rounded-xl`}>
                                                        <div className={`w-8 h-8 rounded-full ${isAutoResolved ? 'bg-green-100' : 'bg-primary-100'} flex items-center justify-center flex-shrink-0`}>
                                                            <span className={`text-sm font-medium ${isAutoResolved ? 'text-green-600' : 'text-primary-600'}`}>
                                                                {selectedUser.display_name?.charAt(0)?.toUpperCase() || '?'}
                                                            </span>
                                                        </div>
                                                        <div className="flex-1 min-w-0">
                                                            <p className="text-sm font-medium text-gray-900 truncate">{selectedUser.display_name}</p>
                                                            <p className="text-xs text-gray-500 truncate">{selectedUser.email}</p>
                                                            {isAutoResolved && <p className="text-xs text-green-600 mt-0.5">Auto-assigned from HRIMS</p>}
                                                        </div>
                                                        <button
                                                            type="button"
                                                            onClick={() => { handleRemoveApprover(role.key); setAutoResolvedRoles(prev => ({ ...prev, [role.key]: false })); }}
                                                            className="p-1.5 rounded-lg hover:bg-danger-50 text-gray-400 hover:text-danger-500 transition-colors"
                                                            title="Change approver"
                                                        >
                                                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" />
                                                            </svg>
                                                        </button>
                                                    </div>
                                                ) : (
                                                    <div className="relative">
                                                        {!loadingApproverResolution && !isEditMode && (
                                                            <p className="text-xs text-amber-600 mb-1">No user found in HRIMS for this role. Please select manually.</p>
                                                        )}
                                                        <div className="relative">
                                                            <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                                                            </svg>
                                                            <input
                                                                type="text"
                                                                className="w-full pl-10 pr-4 py-2 min-h-[44px] rounded-xl border border-gray-300 bg-white text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-all"
                                                                placeholder={`Search for ${role.label}...`}
                                                                value={approverSearch[role.key] || ''}
                                                                onChange={(e) => {
                                                                    setApproverSearch(prev => ({ ...prev, [role.key]: e.target.value }));
                                                                    setShowApproverDropdown(role.key);
                                                                }}
                                                                onFocus={() => setShowApproverDropdown(role.key)}
                                                            />
                                                        </div>

                                                        {/* Dropdown Results */}
                                                        {showApproverDropdown === role.key && (
                                                            <div className="absolute z-20 w-full mt-1 bg-white border border-gray-200 rounded-xl shadow-lg max-h-48 overflow-y-auto">
                                                                {loadingUsers ? (
                                                                    <div className="flex items-center justify-center py-4">
                                                                        <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-primary-500" />
                                                                    </div>
                                                                ) : filteredUsers.length === 0 ? (
                                                                    <div className="px-4 py-3 text-sm text-gray-500">
                                                                        No users found
                                                                    </div>
                                                                ) : (
                                                                    filteredUsers.slice(0, 10).map((u) => (
                                                                        <button
                                                                            key={u.id}
                                                                            type="button"
                                                                            onClick={() => handleSelectApprover(role.key, u.id)}
                                                                            className="w-full px-4 py-3 text-left hover:bg-primary-50 transition-colors flex items-center gap-3 border-b border-gray-100 last:border-b-0"
                                                                        >
                                                                            <div className="w-8 h-8 rounded-full bg-primary-100 flex items-center justify-center flex-shrink-0">
                                                                                <span className="text-sm font-medium text-primary-600">
                                                                                    {u.display_name?.charAt(0)?.toUpperCase() || '?'}
                                                                                </span>
                                                                            </div>
                                                                            <div className="flex-1 min-w-0">
                                                                                <p className="text-sm font-medium text-gray-900 truncate">{u.display_name}</p>
                                                                                <p className="text-xs text-gray-500 truncate">{u.email}</p>
                                                                            </div>
                                                                        </button>
                                                                    ))
                                                                )}
                                                            </div>
                                                        )}
                                                    </div>
                                                )}
                                            </div>
                                        </div>

                                        {/* Connecting line between steps */}
                                        {index < approvalRoles.length - 1 && (
                                            <div className="absolute left-5 top-12 bottom-0 w-0.5 bg-gray-200 -mb-4 h-8" style={{ transform: 'translateX(-50%)' }} />
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    </Card>

                    {/* Watchers Section */}
                    <Card className="p-6">
                        <div className="flex items-start justify-between mb-4">
                            <div>
                                <h3 className="text-xl font-bold text-gray-900 font-heading">Watchers (Optional)</h3>
                                <p className="text-sm text-gray-500 mt-1">
                                    Add colleagues who need visibility on this voucher request. Watchers can view the request details and generate the voucher PDF once approved, but cannot make changes or approve.
                                </p>
                            </div>
                            <div className="flex items-center gap-1.5 px-2.5 py-1 bg-[#F3EADC] text-[#5E4426] rounded-full text-xs font-medium">
                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                                </svg>
                                View Only
                            </div>
                        </div>

                        {/* Click outside to close dropdown */}
                        {showWatcherDropdown && (
                            <div
                                className="fixed inset-0 z-10"
                                onClick={() => setShowWatcherDropdown(false)}
                            />
                        )}

                        {/* Selected Watchers */}
                        {selectedWatchers.length > 0 && (
                            <div className="mb-4 flex flex-wrap gap-2">
                                {selectedWatchers.map((watcher) => (
                                    <div
                                        key={watcher.id}
                                        className="flex items-center gap-2 bg-[#F3EADC] border border-[#C9B896] px-3 py-1.5 rounded-full"
                                    >
                                        <div className="w-6 h-6 rounded-full bg-[#F3EADC] flex items-center justify-center flex-shrink-0">
                                            <span className="text-xs font-medium text-[#9A7545]">
                                                {watcher.display_name?.charAt(0)?.toUpperCase() || '?'}
                                            </span>
                                        </div>
                                        <span className="text-sm font-medium text-gray-900">{watcher.display_name}</span>
                                        <button
                                            type="button"
                                            onClick={() => handleRemoveWatcher(watcher.id)}
                                            className="p-0.5 rounded-full hover:bg-[#E6D3B3] text-[#C9A574] hover:text-[#9A7545] transition-colors"
                                            title="Remove watcher"
                                        >
                                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" />
                                            </svg>
                                        </button>
                                    </div>
                                ))}
                            </div>
                        )}

                        {/* Search Input */}
                        <div className="relative">
                            <div className="relative">
                                <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                                </svg>
                                <input
                                    type="text"
                                    className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-gray-300 bg-white text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-[#9A7545] focus:border-transparent transition-all"
                                    placeholder="Search for users to add as watchers..."
                                    value={watcherSearch}
                                    onChange={(e) => {
                                        setWatcherSearch(e.target.value);
                                        setShowWatcherDropdown(true);
                                    }}
                                    onFocus={() => setShowWatcherDropdown(true)}
                                />
                            </div>

                            {/* Dropdown Results */}
                            {showWatcherDropdown && (
                                <div className="absolute z-20 w-full mt-1 bg-white border border-gray-200 rounded-xl shadow-lg max-h-48 overflow-y-auto">
                                    {loadingUsers ? (
                                        <div className="flex items-center justify-center py-4">
                                            <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-[#9A7545]" />
                                        </div>
                                    ) : getFilteredUsersForWatchers().length === 0 ? (
                                        <div className="px-4 py-3 text-sm text-gray-500">
                                            {watcherSearch ? 'No users found' : 'Start typing to search for users'}
                                        </div>
                                    ) : (
                                        getFilteredUsersForWatchers().slice(0, 8).map((u) => (
                                            <button
                                                key={u.id}
                                                type="button"
                                                onClick={() => handleSelectWatcher(u.id)}
                                                className="w-full px-4 py-3 text-left hover:bg-[#F3EADC] transition-colors flex items-center gap-3 border-b border-gray-100 last:border-b-0"
                                            >
                                                <div className="w-8 h-8 rounded-full bg-[#F3EADC] flex items-center justify-center flex-shrink-0">
                                                    <span className="text-sm font-medium text-[#9A7545]">
                                                        {u.display_name?.charAt(0)?.toUpperCase() || '?'}
                                                    </span>
                                                </div>
                                                <div className="flex-1 min-w-0">
                                                    <p className="text-sm font-medium text-gray-900 truncate">{u.display_name}</p>
                                                    <p className="text-xs text-gray-500 truncate">{u.email}</p>
                                                </div>
                                                <svg className="w-5 h-5 text-[#9A7545] flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                                                </svg>
                                            </button>
                                        ))
                                    )}
                                </div>
                            )}
                        </div>

                        {/* Info box */}
                        <div className="mt-4 p-3 bg-gray-50 border border-gray-200 rounded-xl">
                            <div className="flex items-start gap-2">
                                <svg className="w-4 h-4 text-gray-400 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                                </svg>
                                <p className="text-xs text-gray-500">
                                    Watchers will receive notifications about this request and can access it from their dashboard. They will be able to download the voucher PDF once the request is fully approved.
                                </p>
                            </div>
                        </div>
                    </Card>
                </div>

                {/* Footer Action Bar */}
                <div className="sticky bottom-0 p-4 bg-white/95 backdrop-blur-sm border-t border-gray-100 pb-safe z-10 shadow-lg">
                    <div className="flex gap-3 max-w-5xl mx-auto">
                        {isApproverEditing ? (
                            <>
                                <Button type="button" variant="secondary" className="flex-1" onClick={() => router.back()}>Cancel</Button>
                                <Button type="submit" variant="primary" className="flex-1 shadow-primary-500/25 shadow-lg" isLoading={loading}>Save Changes</Button>
                            </>
                        ) : isEditMode ? (
                            <>
                                <Button type="button" variant="secondary" className="flex-1" onClick={() => router.back()}>Cancel</Button>
                                <Button type="submit" variant="primary" className="flex-1 shadow-primary-500/25 shadow-lg" isLoading={loading || savingDraft}>Save Changes</Button>
                            </>
                        ) : (
                            <>
                                <Button type="button" variant="secondary" className="flex-1" onClick={() => router.back()}>Cancel</Button>
                                <Button type="button" variant="secondary" className="flex-1 border-primary-300 text-primary-600 hover:bg-primary-50" onClick={handleSaveDraft} isLoading={savingDraft} disabled={loading}>Save as Draft</Button>
                                <Button type="submit" variant="primary" className="flex-1 shadow-primary-500/25 shadow-lg" isLoading={loading} disabled={savingDraft}>Submit Request</Button>
                            </>
                        )}
                    </div>
                </div>
            </form>

            <RequestPreviewModal
                isOpen={showPreview}
                onClose={() => setShowPreview(false)}
                mode="preview"
                title="Voucher Request"
                sections={buildPreviewSections()}
            />
            <RequestPreviewModal
                isOpen={showConfirm}
                onClose={() => setShowConfirm(false)}
                mode="confirm"
                title="Voucher Request"
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

