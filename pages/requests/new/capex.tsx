import { useCurrentUser } from '../../../hooks/useCurrentUser';
import { useUserHrimsProfile } from '../../../hooks/useUserHrimsProfile';
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import { AppLayout } from '../../../components/layout';
import { Card, Button, Input, RequestPreviewModal, UnsavedChangesModal, ReferenceCodeBanner } from '../../../components/ui';
import type { PreviewSection, DocumentHeader } from '../../../components/ui';
import { useUnsavedChangesPrompt, useFormAutosave } from '../../../hooks';
import { useToast } from '../../../components/ui/ToastProvider';
import { OnBehalfOfField, type OnBehalfOf } from '../../../components/requests/OnBehalfOfField';
import { isApproverRowLocked } from '../../../lib/approverLocking';
import ApproverSectionLoader from '../../../components/requests/ApproverSectionLoader';
import { CAPEX_APPROVAL_ROLES, CAPEX_APPROVAL_SECTIONS } from '../../../lib/capexApproval';
import { buildCapexPreviewSections } from '../../../lib/previews/capexPreview';
import { formatMoneyInput } from '../../../lib/money';

interface DocumentMetadata {
  file: File;
  description: string;
  supplierName: string;
  /** Quoted amount for this supplier, e.g. "6,805.20". Shown on the CAPEX form. */
  amount: string;
  isSelectedSupplier: boolean;
  selectionReason: string;
  /**
   * In multiple-suppliers mode, the value of the items actually being sourced
   * from THIS quotation (a subset of the full quotation total in `amount`).
   * This is the figure summed into the Project Cost. Optional/blank when not in
   * multi-supplier mode, in which case the full quotation amount is used.
   */
  sourcedAmount?: string;
}

export default function NewCapexRequestPage() {
  const { data: session, status } = useSession();
  const { user } = useCurrentUser();
  const { departmentName, businessUnitName } = useUserHrimsProfile();
  const router = useRouter();
  const { addToast } = useToast();
  const [loading, setLoading] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Per-field validation messages, keyed by field name (e.g. 'projectName').
  // Populated when a submit/draft is blocked so we can show inline errors.
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [businessUnits, setBusinessUnits] = useState<Array<{ id: string; name: string }>>([]);
  const [loadingUnits, setLoadingUnits] = useState(true);
  const [departments, setDepartments] = useState<Array<{ id: string; name: string; code: string }>>([]);
  const [loadingDepartments, setLoadingDepartments] = useState(true);
  const [users, setUsers] = useState<Array<{ id: string; display_name: string; email: string; job_title?: string }>>([]);
  const [loadingUsers, setLoadingUsers] = useState(true);
  
  // Standard CAPEX approval chain (shared source of truth: lib/capexApproval.ts).
  // Grouped into the "Project Requested By" / "Project Approved By" sections that
  // appear on the official form. Approvers are OPTIONAL — blank roles still print.
  const approvalRoles = CAPEX_APPROVAL_ROLES;
  const approvalSections = CAPEX_APPROVAL_SECTIONS;
  const [selectedApprovers, setSelectedApprovers] = useState<Record<string, string>>({
    finance_manager: '',
    general_manager: '',
    procurement_manager: '',
    corporate_hod: '',
    managing_director: '',
    finance_director: '',
    ceo: '',
  });
  const [approverSearch, setApproverSearch] = useState<Record<string, string>>({
    finance_manager: '',
    general_manager: '',
    procurement_manager: '',
    corporate_hod: '',
    managing_director: '',
    finance_director: '',
    ceo: '',
  });
  const [showApproverDropdown, setShowApproverDropdown] = useState<string | null>(null);
  const [useParallelApprovals, setUseParallelApprovals] = useState(false);
  const [loadingApproverResolution, setLoadingApproverResolution] = useState(true);
  const [autoResolvedRoles, setAutoResolvedRoles] = useState<Record<string, boolean>>({});
  const [selectedWatchers, setSelectedWatchers] = useState<Array<{ id: string; addedBy?: { id: string; name: string; isApprover: boolean }; addedAt?: string }>>([]);
  const [watcherSearch, setWatcherSearch] = useState('');
  const [showWatcherDropdown, setShowWatcherDropdown] = useState(false);
  const [quotationDocuments, setQuotationDocuments] = useState<DocumentMetadata[]>([]);
  // Multiple-suppliers mode: when on, more than one uploaded quotation can be
  // flagged as a selected supplier and their amounts sum to the Project Cost.
  const [allowMultipleSuppliers, setAllowMultipleSuppliers] = useState(false);
  const [quotationJustification, setQuotationJustification] = useState('');
  const [quotationReason, setQuotationReason] = useState<string>('');
  const [supportingDocuments, setSupportingDocuments] = useState<DocumentMetadata[]>([]);
  // Comparative Analysis — required once 3+ quotations are provided (so it can
  // compare them). Waived when fewer than 3 quotations were uploaded, since the
  // requester has already given a reason for the shortfall.
  const [comparativeAnalysisDocuments, setComparativeAnalysisDocuments] = useState<DocumentMetadata[]>([]);
  const [existingComparativeAnalysis, setExistingComparativeAnalysis] = useState<any[]>([]);
  const [onBehalfOf, setOnBehalfOf] = useState<OnBehalfOf | null>(null);

  // Supplier directory (auto-populated from prior CAPEX requests) powering the
  // supplier-name autocomplete on each quotation. activeSupplierField tracks
  // which quotation row's dropdown is currently open.
  const [supplierSuggestions, setSupplierSuggestions] = useState<Array<{ id: string; name: string; products: string | null; currency: string }>>([]);
  const [activeSupplierField, setActiveSupplierField] = useState<number | null>(null);

  const QUOTATION_REASONS: Array<{ value: string; label: string }> = [
    { value: 'existing_supplier', label: 'Existing supplier — continuity required' },
    { value: 'sole_supplier', label: 'Sole supplier — no alternatives available' },
    { value: 'specialized', label: 'Specialized service requiring specific expertise' },
    { value: 'other', label: 'Other reason — requires COO pre-approval first' },
  ];

  const requiresMdApproval = quotationReason === 'other';

  // When "Other" is chosen the Chief Operating Officer must pre-approve. The COO is
  // taken straight from the HRIMS-resolved approval chain (managing_director
  // role) — there is no manual picker. They are prepended to the approval
  // trail so the request can't proceed until the MD signs off.
  const mdApproverId = selectedApprovers.managing_director || '';

  // Edit mode state
  const { edit: editRequestId, approver: isApproverEdit } = router.query;
  const isEditMode = !!editRequestId;
  const isApproverEditing = isApproverEdit === 'true';
  const [loadingRequest, setLoadingRequest] = useState(false);
  const [originalFormData, setOriginalFormData] = useState<any>(null);
  const [showPublishModal, setShowPublishModal] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [requestStatus, setRequestStatus] = useState<string>('draft');
  const [originalWatchers, setOriginalWatchers] = useState<Array<{ id: string; addedBy?: { id: string; name: string; isApprover: boolean }; addedAt?: string }>>([]);
  const [existingQuotations, setExistingQuotations] = useState<any[]>([]);
  const [existingSupportingDocs, setExistingSupportingDocs] = useState<any[]>([]);
  // Actual uploaded files (documents table) loaded in edit mode — used to map a
  // metadata entry back to its stored document so it can be deleted.
  const [loadedDocuments, setLoadedDocuments] = useState<Array<{ id: string; filename: string }>>([]);
  // Document ids the user removed while editing — deleted from storage on save.
  const [removedDocumentIds, setRemovedDocumentIds] = useState<string[]>([]);
  const [referenceCode, setReferenceCode] = useState<string | null>(null);
  const [existingReferenceCode, setExistingReferenceCode] = useState<string | null>(null);

  const [formData, setFormData] = useState({
    requester: session?.user?.name || '',
    unit: '',
    department: '',
    projectName: '',
    description: '',
    budgetType: '', // budget, non-budget, emergency
    isBudgeted: true, // "This CAPEX is not part of the approved annual budget" = false
    budgetAmount: '', // Budgeted CAPEX only: total approved annual budget line
    amountSpent: '', // Budgeted CAPEX only: amount already spent against that budget
    amount: '', // project cost
    currency: 'USD',
    justification: '',
    paybackPeriod: '',
    npv: '',
    irr: '',
    fundingSource: '',
    evaluation: '',
    category: '', // kept for consistency if needed, but not explicitly asked for in new list. Will keep as it's useful.
    startDate: '', // kept
    endDate: '', // kept
    priority: '', // urgency/priority level
  });

  // Unsaved-changes tracking — flipped true on first real user interaction via form onChange.
  const [isDirty, setIsDirty] = useState(false);

  // Autosave / crash recovery (serializable slices only). Disabled in edit mode.
  useFormAutosave({
    formKey: 'capex',
    enabled: !isEditMode,
    data: { formData, selectedApprovers, selectedWatchers },
    onRestore: (saved) => {
      if (saved.formData) setFormData(saved.formData);
      if (saved.selectedApprovers) setSelectedApprovers(prev => ({ ...prev, ...saved.selectedApprovers }));
      if (Array.isArray(saved.selectedWatchers)) setSelectedWatchers(saved.selectedWatchers);
      setIsDirty(true);
    },
  });

  const unsavedPrompt = useUnsavedChangesPrompt({
    isDirty,
    // Suppress the "discard changes?" prompt while we are actively
    // submitting, saving a draft, or publishing — in all of these cases the
    // handler performs its own navigation and the changes are being saved,
    // so the user must not be asked to discard them.
    disabled: loading || savingDraft || publishing,
  });

  const handleQuotationUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files) {
      const newDocs: DocumentMetadata[] = Array.from(files).map(file => ({
        file,
        description: '',
        supplierName: '',
        amount: '',
        isSelectedSupplier: false,
        selectionReason: '',
      }));
      // The standard is 3 quotations, but more are allowed (no hard cap).
      setQuotationDocuments(prev => [...prev, ...newDocs]);
    }
  };

  const handleRemoveQuotation = (index: number) => {
    setQuotationDocuments(prev => prev.filter((_, i) => i !== index));
  };

  const handleSupportingDocUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files) {
      const newDocs: DocumentMetadata[] = Array.from(files).map(file => ({
        file,
        description: '',
        supplierName: '',
        amount: '',
        isSelectedSupplier: false,
        selectionReason: '',
      }));
      setSupportingDocuments(prev => [...prev, ...newDocs]);
    }
  };

  const handleRemoveSupportingDoc = (index: number) => {
    setSupportingDocuments(prev => prev.filter((_, i) => i !== index));
  };

  const handleComparativeAnalysisUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files) {
      const newDocs: DocumentMetadata[] = Array.from(files).map(file => ({
        file,
        description: '',
        supplierName: '',
        amount: '',
        isSelectedSupplier: false,
        selectionReason: '',
      }));
      setComparativeAnalysisDocuments(prev => [...prev, ...newDocs]);
    }
  };

  const handleRemoveComparativeAnalysis = (index: number) => {
    setComparativeAnalysisDocuments(prev => prev.filter((_, i) => i !== index));
  };

  // ---- Existing (already-uploaded) documents: edit + remove ----
  // Resolve a metadata entry to its stored document id so it can be deleted on save.
  const resolveDocumentId = (item: any): string | null =>
    item?.documentId || loadedDocuments.find(d => d.filename === item?.name)?.id || null;

  const markDocumentRemoved = (item: any) => {
    const docId = resolveDocumentId(item);
    if (docId) setRemovedDocumentIds(prev => (prev.includes(docId) ? prev : [...prev, docId]));
  };

  const handleRemoveExistingQuotation = (index: number) => {
    setExistingQuotations(prev => {
      const item = prev[index];
      if (item) markDocumentRemoved(item);
      return prev.filter((_, i) => i !== index);
    });
  };

  const handleUpdateExistingQuotation = (index: number, field: string, value: string | boolean) => {
    setExistingQuotations(prev => prev.map((q, i) => (i === index ? { ...q, [field]: value } : q)));
  };

  const handleRemoveExistingSupportingDoc = (index: number) => {
    setExistingSupportingDocs(prev => {
      const item = prev[index];
      if (item) markDocumentRemoved(item);
      return prev.filter((_, i) => i !== index);
    });
  };

  const handleRemoveExistingComparativeAnalysis = (index: number) => {
    setExistingComparativeAnalysis(prev => {
      const item = prev[index];
      if (item) markDocumentRemoved(item);
      return prev.filter((_, i) => i !== index);
    });
  };

  const handleAddWatcher = (userId: string) => {
    if (!selectedWatchers.find(w => w.id === userId)) {
      const newWatcher = {
        id: userId,
        addedBy: isApproverEditing ? {
          id: user?.id || session?.user?.id || '',
          name: user?.display_name || session?.user?.name || 'Unknown',
          isApprover: true,
        } : undefined,
        addedAt: isApproverEditing ? new Date().toISOString() : undefined,
      };
      setSelectedWatchers(prev => [...prev, newWatcher]);
    }
    setWatcherSearch('');
    setShowWatcherDropdown(false);
  };

  const handleRemoveWatcher = (watcherId: string) => {
    // Approvers can only remove watchers they added
    if (isApproverEditing) {
      const watcher = selectedWatchers.find(w => w.id === watcherId);
      if (watcher && watcher.addedBy?.id !== (user?.id || session?.user?.id)) {
        return; // Can't remove watchers added by others
      }
    }
    setSelectedWatchers(prev => prev.filter(w => w.id !== watcherId));
  };

  const filteredWatchers = users.filter(u =>
    !selectedWatchers.find(w => w.id === u.id) &&
    (u.display_name?.toLowerCase().includes(watcherSearch.toLowerCase()) ||
      u.email?.toLowerCase().includes(watcherSearch.toLowerCase()))
  );

  // Directory search: when the user types in a watcher/approver picker, query
  // /api/users/search. On staging this returns app_users; in production
  // (USER_DIRECTORY_SOURCE=azure) it returns live Azure AD directory matches,
  // JIT-provisioned to app_users ids. Matches are merged into `users` so both
  // the client-side filtering and the selected-name lookups keep working.
  const activeUserSearchTerm = showWatcherDropdown
    ? watcherSearch
    : (showApproverDropdown ? (approverSearch[showApproverDropdown] || '') : '');

  useEffect(() => {
    const term = activeUserSearchTerm.trim();
    if (term.length < 2) return;
    const handle = setTimeout(async () => {
      try {
        const resp = await fetch(`/api/users/search?q=${encodeURIComponent(term)}`);
        if (!resp.ok) return;
        const data = await resp.json();
        const found = (data.users || []) as Array<{ id: string; display_name: string; email: string; job_title?: string }>;
        if (found.length === 0) return;
        setUsers(prev => {
          const map = new Map(prev.map(u => [u.id, u]));
          for (const u of found) if (!map.has(u.id)) map.set(u.id, u);
          return Array.from(map.values());
        });
      } catch (err) {
        console.error('User directory search failed:', err);
      }
    }, 300);
    return () => clearTimeout(handle);
  }, [activeUserSearchTerm]);

  const handleUpdateQuotationMetadata = (index: number, field: keyof DocumentMetadata, value: string | boolean) => {
    setQuotationDocuments(prev => prev.map((doc, i) => {
      if (i === index) {
        return { ...doc, [field]: value };
      }
      // In single-supplier mode selecting one quotation deselects the others.
      // In multiple-suppliers mode several quotations may be selected at once.
      if (field === 'isSelectedSupplier' && value === true && !allowMultipleSuppliers) {
        return { ...doc, isSelectedSupplier: false, selectionReason: '' };
      }
      return doc;
    }));
  };

  const handleUpdateSupportingDocMetadata = (index: number, field: keyof DocumentMetadata, value: string | boolean) => {
    setSupportingDocuments(prev => prev.map((doc, i) => {
      if (i === index) {
        return { ...doc, [field]: value };
      }
      return doc;
    }));
  };

  // Fetch existing request data when in edit mode
  useEffect(() => {
    const fetchExistingRequest = async () => {
      if (!editRequestId || typeof editRequestId !== 'string') return;
      
      setLoadingRequest(true);
      try {
        const response = await fetch(`/api/requests/${editRequestId}`);
        if (!response.ok) {
          throw new Error('Failed to fetch request');
        }
        const data = await response.json();
        const request = data.request;
        const metadata = request.metadata || {};
        const capexData = metadata.capex || metadata;

        // Store request status
        setRequestStatus(request.status || 'draft');
        if (metadata.referenceCode) setExistingReferenceCode(metadata.referenceCode);

        // Store original data for comparison (for modification tracking)
        setOriginalFormData({
          requester: capexData.requester || metadata.requester || '',
          unit: capexData.unit || metadata.unit || '',
          department: capexData.department || metadata.department || '',
          projectName: capexData.projectName || metadata.projectName || '',
          description: capexData.description || request.description || '',
          budgetType: capexData.budgetType || metadata.budgetType || '',
          isBudgeted: typeof capexData.isBudgeted === 'boolean'
            ? capexData.isBudgeted
            : (typeof metadata.isBudgeted === 'boolean' ? metadata.isBudgeted : true),
          budgetAmount: capexData.budgetAmount || metadata.budgetAmount || '',
          amountSpent: capexData.amountSpent || metadata.amountSpent || '',
          amount: capexData.amount || metadata.amount || '',
          currency: capexData.currency || metadata.currency || 'USD',
          justification: capexData.justification || metadata.justification || '',
          paybackPeriod: capexData.paybackPeriod || metadata.paybackPeriod || '',
          npv: capexData.npv || metadata.npv || '',
          irr: capexData.irr || metadata.irr || '',
          fundingSource: capexData.fundingSource || metadata.fundingSource || '',
          evaluation: capexData.evaluation || metadata.evaluation || '',
          startDate: capexData.startDate || metadata.startDate || '',
          endDate: capexData.endDate || metadata.endDate || '',
          priority: capexData.priority || metadata.priority || '',
        });

        // Pre-fill form with existing data
        setFormData({
          requester: capexData.requester || metadata.requester || '',
          unit: capexData.unit || metadata.unit || '',
          department: capexData.department || metadata.department || '',
          projectName: capexData.projectName || metadata.projectName || '',
          description: capexData.description || request.description || '',
          budgetType: capexData.budgetType || metadata.budgetType || '',
          isBudgeted: typeof capexData.isBudgeted === 'boolean'
            ? capexData.isBudgeted
            : (typeof metadata.isBudgeted === 'boolean' ? metadata.isBudgeted : true),
          budgetAmount: capexData.budgetAmount || metadata.budgetAmount || '',
          amountSpent: capexData.amountSpent || metadata.amountSpent || '',
          amount: capexData.amount || metadata.amount || '',
          currency: capexData.currency || metadata.currency || 'USD',
          justification: capexData.justification || metadata.justification || '',
          paybackPeriod: capexData.paybackPeriod || metadata.paybackPeriod || '',
          npv: capexData.npv || metadata.npv || '',
          irr: capexData.irr || metadata.irr || '',
          fundingSource: capexData.fundingSource || metadata.fundingSource || '',
          evaluation: capexData.evaluation || metadata.evaluation || '',
          category: '',
          startDate: capexData.startDate || metadata.startDate || '',
          endDate: capexData.endDate || metadata.endDate || '',
          priority: capexData.priority || metadata.priority || '',
        });

        // Set approvers and watchers
        // Handle both new format (approverRoles object) and legacy format (array)
        // Check both root level and nested capex level
        const approverRolesData = metadata.approverRoles || capexData.approverRoles;
        const approversData = metadata.approvers || capexData.approvers;
        const watchersData = metadata.watchers || capexData.watchers;
        
        if (approverRolesData && typeof approverRolesData === 'object' && !Array.isArray(approverRolesData)) {
          // New format: approverRoles is an object with role keys
          setSelectedApprovers(prev => ({ ...prev, ...approverRolesData }));
        } else if (approversData && typeof approversData === 'object' && !Array.isArray(approversData)) {
          // Fallback: approvers was saved as an object (old bug)
          setSelectedApprovers(prev => ({ ...prev, ...approversData }));
        } else if (approversData && Array.isArray(approversData)) {
          // Legacy format: convert array to role-based object (best effort mapping)
          const approverArray = approversData as string[];
          const roleKeys = ['finance_manager', 'general_manager', 'procurement_manager', 'corporate_hod', 'managing_director', 'finance_director', 'ceo'];
          const mappedApprovers: Record<string, string> = {};
          approverArray.forEach((id, index) => {
            if (index < roleKeys.length) {
              mappedApprovers[roleKeys[index]] = id;
            }
          });
          setSelectedApprovers(prev => ({ ...prev, ...mappedApprovers }));
        }
        if (watchersData && Array.isArray(watchersData)) {
          // Convert old format (string[]) to new format if needed
          const watchersWithMetadata = watchersData.map((w: any) => {
            if (typeof w === 'string') {
              return { id: w };
            }
            return w;
          });
          setSelectedWatchers(watchersWithMetadata);
          setOriginalWatchers(watchersWithMetadata);
        }

        // Multiple-suppliers mode — restore the toggle.
        const multiSupplierFlag = metadata.allowMultipleSuppliers ?? capexData.allowMultipleSuppliers;
        if (typeof multiSupplierFlag === 'boolean') {
          setAllowMultipleSuppliers(multiSupplierFlag);
        }

        // Store existing document metadata (we can't re-upload existing files, but show them)
        // Check both root level and nested capex level for document arrays
        const quotationsData = metadata.quotations || capexData.quotations;
        const supportingDocsData = metadata.supportingDocuments || capexData.supportingDocuments;
        const comparativeAnalysisData = metadata.comparativeAnalysis || capexData.comparativeAnalysis;
        const justificationData = metadata.quotationJustification || capexData.quotationJustification;

        if (quotationsData && Array.isArray(quotationsData)) {
          setExistingQuotations(quotationsData);
        }
        if (supportingDocsData && Array.isArray(supportingDocsData)) {
          setExistingSupportingDocs(supportingDocsData);
        }
        if (comparativeAnalysisData && Array.isArray(comparativeAnalysisData)) {
          setExistingComparativeAnalysis(comparativeAnalysisData);
        }
        if (justificationData) {
          setQuotationJustification(justificationData);
        }
        const reasonData = metadata.quotationReason || capexData.quotationReason;
        if (reasonData) {
          setQuotationReason(reasonData);
        }

        // Also check for documents from the documents table (actual uploaded files)
        // and match them with metadata if metadata is missing
        if (request.documents && Array.isArray(request.documents) && request.documents.length > 0) {
          // Keep the id↔filename map so an existing metadata entry can be
          // resolved back to its stored file for deletion when removed.
          setLoadedDocuments(
            request.documents.map((doc: any) => ({ id: doc.id, filename: doc.filename }))
          );
          // If we have documents in the table but no metadata, create metadata from documents
          if (!quotationsData && !supportingDocsData) {
            // All documents without metadata categorization - show them as existing quotations
            const docsFromTable = request.documents.map((doc: any) => ({
              name: doc.filename,
              size: doc.file_size,
              type: doc.mime_type,
              description: '',
              supplierName: '',
              amount: '',
              isSelectedSupplier: false,
              selectionReason: '',
              documentId: doc.id, // Keep reference to actual document
            }));
            setExistingQuotations(docsFromTable);
          }
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

  // Pre-fill requester, unit, and department from user profile (only for new requests)
  useEffect(() => {
    if (isEditMode) return; // Skip for edit mode
    
    if (user) {
      setFormData(prev => ({
        ...prev,
        requester: user.display_name || user.email || session?.user?.name || prev.requester,
        unit: businessUnitName || prev.unit,
        department: departmentName || prev.department,
      }));
    } else if (session?.user?.name && !formData.requester) {
      // Fallback to session name if user profile not yet loaded/available
      setFormData(prev => ({ ...prev, requester: session.user.name || '' }));
    }
    // businessUnitName / departmentName resolve asynchronously from the HRIMS
    // profile — they MUST be in the deps, otherwise a name that arrives after
    // this effect last ran never lands in formData and the request saves with a
    // blank unit/department (shows as N/A on the details tab).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, session, isEditMode, businessUnitName, departmentName]);

  // Filing on behalf of a principal: the request must read as if THEY raised it,
  // so the (read-only) Requester field shows the principal's name — autofilled
  // the moment they're selected. Restore the signed-in user's own name when
  // cleared. Skipped in edit mode (the stored requester is authoritative there).
  useEffect(() => {
    if (isEditMode) return;
    if (onBehalfOf?.userId) {
      setFormData(prev => ({ ...prev, requester: onBehalfOf.name || '' }));
    } else {
      setFormData(prev => ({ ...prev, requester: user?.display_name || session?.user?.name || prev.requester }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onBehalfOf?.userId]);

  useEffect(() => {
    if (status === 'unauthenticated') {
      router.push('/');
    }
  }, [status, router]);

  useEffect(() => {
    const fetchBusinessUnits = async () => {
      try {
        const response = await fetch('/api/business-units');
        if (response.ok) {
          const data = await response.json();
          setBusinessUnits(data.businessUnits || []);
        }
      } catch (err) {
        console.error('Failed to fetch business units:', err);
      } finally {
        setLoadingUnits(false);
      }
    };

    const fetchDepartments = async () => {
      try {
        const response = await fetch('/api/departments');
        if (response.ok) {
          const data = await response.json();
          setDepartments(data.departments || []);
        }
      } catch (err) {
        console.error('Failed to fetch departments:', err);
      } finally {
        setLoadingDepartments(false);
      }
    };

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

    const fetchSuppliers = async () => {
      try {
        const response = await fetch('/api/finance/suppliers');
        if (response.ok) {
          const data = await response.json();
          setSupplierSuggestions(data.suppliers || []);
        }
      } catch (err) {
        console.error('Failed to fetch suppliers:', err);
      }
    };

    if (status === 'authenticated') {
      fetchBusinessUnits();
      fetchDepartments();
      fetchUsers();
      fetchSuppliers();
    }
  }, [status]);

  // Auto-resolve approvers from HRIMS organogram (only on new requests, not edits)
  useEffect(() => {
    const resolveApprovers = async () => {
      if (!session?.user?.email || isEditMode) { setLoadingApproverResolution(false); return; }
      setLoadingApproverResolution(true);
      try {
        const response = await fetch(
          `/api/hrims/resolve-approvers?email=${encodeURIComponent(session.user.email)}&formType=capex`
        );
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
          console.error('[capex] Approver resolution failed:', data.error || 'Unknown error');
        }
      } catch (err) {
        console.error('[capex] Failed to auto-resolve approvers:', err);
      } finally {
        setLoadingApproverResolution(false);
      }
    };
    if (status === 'authenticated') resolveApprovers();
  }, [status, session?.user?.email, isEditMode]);

  const [showPreview, setShowPreview] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  // The official CAPEX form is a plain black-and-white document (see the RTG
  // template): centred logo + title, then flowing "LABEL: value" lines and a
  // flat signature block. No boxed grid, no doc-id strip, no brand colour.
  const capexDocumentHeader: DocumentHeader = {
    logoUrl: '/images/RTG_LOGO.png',
    docNo: '',
    department: '',
    page: '',
  };

  const PAYBACK_PERIOD_LABELS: Record<string, string> = {
    '<6m': 'Less than 6 months',
    '6-12m': '6 to 12 months',
    '1-2y': '1 to 2 years',
    '2-3y': '2 to 3 years',
    '>3y': 'More than 3 years',
  };

  const buildPreviewSections = (): PreviewSection[] => {
    // On-behalf: the principal is the requestor of record on the document.
    const requestorName = onBehalfOf?.userId
      ? (onBehalfOf.name || formData.requester || '')
      : (formData.requester || user?.display_name || session?.user?.name || '');
    const departmentLabel = departments.find(d => d.id === formData.department)?.name || formData.department || departmentName || '';
    const unitLabel = businessUnits.find(u => u.id === formData.unit)?.name || formData.unit || businessUnitName || '';
    const paybackLabel = formData.paybackPeriod
      ? (PAYBACK_PERIOD_LABELS[formData.paybackPeriod] || formData.paybackPeriod)
      : '';

    const curr = formData.currency || 'USD';
    const money = (v?: string) => `$ ${curr} ${v && String(v).trim() ? v : 'NIL'}`;
    const budgetTypeMap: Record<string, string> = { budget: 'BUDGETED', 'non-budget': 'NON-BUDGETED', emergency: 'EMERGENCY' };
    const budgetTypeDisplay = budgetTypeMap[formData.budgetType] || (formData.budgetType ? formData.budgetType.toUpperCase() : '');
    const balanceBefore = isBudgetedCapex
      ? formatCurrency(String(parseCurrency(formData.budgetAmount) - parseCurrency(formData.amountSpent)))
      : '';

    // Combined quotations (already-saved + newly-uploaded), in display order.
    const allQuotes: Array<{ supplier: string; amount: string; selected: boolean; reason: string }> = [
      ...(Array.isArray(existingQuotations) ? existingQuotations : []).map((q: any) => ({
        supplier: q.supplierName || '', amount: q.amount || '', selected: !!q.isSelectedSupplier, reason: q.selectionReason || '',
      })),
      ...quotationDocuments.map(d => ({
        supplier: d.supplierName || '', amount: d.amount || '', selected: !!d.isSelectedSupplier, reason: d.selectionReason || '',
      })),
    ];
    const preferred = allQuotes.find(q => q.selected);
    const preferredReason = preferred?.reason || quotationJustification || '';
    // Shared renderer (lib/previews/capexPreview) keeps this preview, the
    // detail-page preview and the printed PDF in lockstep.
    return buildCapexPreviewSections({
      unit: unitLabel,
      department: departmentLabel,
      projectName: formData.projectName,
      description: formData.description,
      budgetTypeDisplay,
      currency: curr,
      budgetAmount: formData.budgetAmount,
      amountSpent: formData.amountSpent,
      balance: balanceBefore,
      projectCost: formData.amount,
      balanceAfter: isBudgetedCapex ? budgetBalanceDisplay : '',
      justification: formData.justification,
      payback: paybackLabel,
      npv: formData.npv,
      irr: formData.irr,
      evaluation: formData.evaluation,
      quotations: allQuotes.map(q => ({ supplier: q.supplier, amount: q.amount })),
      multiSupplier: allowMultipleSuppliers,
      selectedSuppliers: selectedSupplierQuotes.map(q => ({
        supplier: q.supplier,
        quoteAmount: q.quoteAmount,
        orderValue: q.sourcedAmount && q.sourcedAmount.trim() ? q.sourcedAmount : q.quoteAmount,
      })),
      preferredSupplier: preferred?.supplier || '',
      reason: preferredReason,
      fundingSource: formData.fundingSource,
      requestedBy: requestorName || departmentLabel,
      approverNameByRole: Object.fromEntries(
        approvalRoles.map(r => [r.key, users.find(u => u.id === selectedApprovers[r.key])?.display_name || ''])
      ),
    });
  };
  // Collect every missing/invalid required field for a full submission, in the
  // order they appear on the form. Each entry carries the `field` anchor (for
  // inline errors + scroll) and a human-readable `message`.
  const getSubmissionErrors = (): { field: string; message: string }[] => {
    const errs: { field: string; message: string }[] = [];
    const totalQuotations = existingQuotations.length + quotationDocuments.length;

    if (!formData.requester) errs.push({ field: 'requester', message: 'Requester is required.' });
    if (!formData.budgetType) errs.push({ field: 'budgetType', message: 'Budget Type is required.' });
    if (!formData.projectName) errs.push({ field: 'projectName', message: 'Project Name / Description is required.' });
    if (!formData.justification) errs.push({ field: 'justification', message: 'Business Justification is required.' });
    if (!formData.amount) errs.push({ field: 'amount', message: 'Project Cost is required.' });
    if (!formData.fundingSource) errs.push({ field: 'fundingSource', message: 'Project Funded By is required.' });
    if (isBudgetedCapex && !formData.budgetAmount) errs.push({ field: 'budgetAmount', message: 'Budget Amount is required for a budgeted CAPEX.' });
    if (isBudgetedCapex && !formData.amountSpent) errs.push({ field: 'amountSpent', message: 'Amount Spent is required for a budgeted CAPEX.' });

    // Approvers are OPTIONAL on CAPEX, but at least one is needed so the request
    // has a workflow to route through.
    if (!isApproverEditing) {
      const selectedApproverCount = approvalRoles.filter(r => selectedApprovers[r.key]).length;
      if (selectedApproverCount < 1) errs.push({ field: 'approvers', message: 'Select at least one approver.' });
    }

    // Multiple-suppliers mode: at least two quotations must be flagged as
    // selected suppliers (that's the whole point of the mode), and each must say
    // how much is being sourced from it.
    if (allowMultipleSuppliers) {
      if (selectedSupplierQuotes.length < 2) {
        errs.push({ field: 'quotations', message: 'Select at least two suppliers when "multiple suppliers" is enabled.' });
      }
      if (selectedSupplierQuotes.some(q => !(q.sourcedAmount && q.sourcedAmount.trim()))) {
        errs.push({ field: 'quotations', message: 'Enter the amount to source from each selected supplier\'s quotation.' });
      }
    }

    // Quotations: require at least 1; if fewer than 3, require a reason.
    if (totalQuotations < 1) {
      errs.push({ field: 'quotations', message: 'Upload at least 1 quotation.' });
    }
    const missingSupplier = quotationDocuments.findIndex(d => !d.supplierName.trim());
    if (missingSupplier !== -1) {
      errs.push({ field: 'quotations', message: `Enter the supplier name for quotation ${missingSupplier + 1}.` });
    }
    const missingAmount = quotationDocuments.findIndex(d => !(d.amount || '').trim());
    if (missingAmount !== -1) {
      errs.push({ field: 'quotations', message: `Enter the amount for quotation ${missingAmount + 1}.` });
    }
    if (totalQuotations < 3) {
      if (!quotationReason) {
        errs.push({ field: 'quotationReason', message: 'Select a reason for uploading fewer than 3 quotations.' });
      } else if (quotationReason === 'other') {
        if (!quotationJustification.trim()) {
          errs.push({ field: 'quotationReason', message: 'Describe your "Other" reason for uploading fewer than 3 quotations.' });
        }
        if (!mdApproverId) {
          errs.push({ field: 'quotationReason', message: 'Selecting "Other" requires the Chief Operating Officer to pre-approve.' });
        }
      }
    }

    // Comparative Analysis is required once 3+ quotations are present (it
    // compares them). With fewer than 3, the requester already justified the
    // shortfall above, so it is not required.
    const totalComparativeAnalysis = existingComparativeAnalysis.length + comparativeAnalysisDocuments.length;
    if (totalQuotations >= 3 && totalComparativeAnalysis < 1) {
      errs.push({ field: 'comparativeAnalysis', message: 'Upload a Comparative Analysis (required when 3 or more quotations are provided).' });
    }

    return errs;
  };

  // Surface a set of validation problems: inline field errors + a banner + a
  // toast listing everything that's missing, then scroll to the first problem.
  const surfaceValidationErrors = (
    errs: { field: string; message: string }[],
    context: 'submit' | 'draft'
  ) => {
    const byField: Record<string, string> = {};
    for (const e of errs) if (!byField[e.field]) byField[e.field] = e.message;
    setFieldErrors(byField);

    const action = context === 'draft' ? 'save this draft' : 'submit';
    setError(`Please fix ${errs.length} item${errs.length > 1 ? 's' : ''} before you can ${action}.`);
    addToast({
      type: 'error',
      title: context === 'draft' ? "Can't save draft yet" : "Can't submit yet",
      message: errs.map(e => e.message).join('  •  '),
      duration: 8000,
    });

    // Scroll the first offending field into view.
    if (typeof document !== 'undefined') {
      requestAnimationFrame(() => {
        const el = document.querySelector(`[data-field="${errs[0].field}"]`);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    }
  };

  // Clear a single field's inline error as soon as the user edits it.
  const clearFieldError = (field: string) =>
    setFieldErrors(prev => (prev[field] ? { ...prev, [field]: '' } : prev));

  const handleSubmit = async (e: React.FormEvent, isDraft: boolean = false, skipConfirm: boolean = false) => {
    e.preventDefault();

    // Validate up front — BEFORE opening the confirm modal (which suppresses
    // toasts) — so we can always tell the user exactly what's missing.
    if (isDraft) {
      // A draft only needs a project name to be persisted. Enforce this only for
      // an explicit "Save as Draft" click (skipConfirm=false); the auto
      // "save draft & continue" path (skipConfirm=true) must never block, or the
      // unsaved-changes flow would navigate away and lose the user's input.
      if (!skipConfirm && !formData.projectName) {
        surfaceValidationErrors(
          [{ field: 'projectName', message: 'Project Name / Description is required to save a draft.' }],
          'draft'
        );
        return;
      }
    } else {
      const errs = getSubmissionErrors();
      if (errs.length > 0) {
        surfaceValidationErrors(errs, 'submit');
        return;
      }
    }
    // Cleared — no outstanding field errors.
    setFieldErrors({});

    // For a true submission (not draft/edit), open confirm modal instead
    if (!isDraft && !isEditMode && !skipConfirm) {
      setShowConfirm(true);
      return;
    }

    if (isDraft) {
      setSavingDraft(true);
    } else {
      setLoading(true);
    }
    setError(null);

    try {
      // Handle edit mode (approver editing)
      if (isEditMode && editRequestId && typeof editRequestId === 'string') {
        // Collect field changes for modification tracking
        const fieldChanges: { fieldName: string; oldValue: any; newValue: any }[] = [];
        
        if (originalFormData) {
          const fieldsToCompare = [
            'requester', 'unit', 'department', 'projectName', 'description',
            'budgetType', 'amount', 'currency', 'justification', 'paybackPeriod',
            'npv', 'irr', 'fundingSource', 'evaluation', 'startDate', 'endDate', 'priority'
          ];
          
          for (const field of fieldsToCompare) {
            const oldVal = originalFormData[field] || '';
            const newVal = (formData as any)[field] || '';
            if (String(oldVal) !== String(newVal)) {
              fieldChanges.push({
                fieldName: field,
                oldValue: oldVal,
                newValue: newVal,
              });
            }
          }
        }

        // Check for watcher changes (new watchers added by approver)
        const newWatcherIds = selectedWatchers.map(w => w.id);
        const originalWatcherIds = originalWatchers.map(w => w.id);
        const addedWatchers = selectedWatchers.filter(w => !originalWatcherIds.includes(w.id));
        const hasWatcherChanges = addedWatchers.length > 0;

        // Use the approver-edit endpoint if approver is editing
        if (isApproverEditing && (fieldChanges.length > 0 || hasWatcherChanges)) {
          // Track watcher additions as field changes
          if (hasWatcherChanges) {
            fieldChanges.push({
              fieldName: 'watchers',
              oldValue: originalWatcherIds.join(', ') || 'None',
              newValue: `Added: ${addedWatchers.map(w => {
                const watcherUser = users.find(u => u.id === w.id);
                return watcherUser?.display_name || w.id;
              }).join(', ')}`,
            });
          }

          const editResponse = await fetch(`/api/requests/${editRequestId}/approver-edit`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
              fieldChanges,
              watchers: selectedWatchers, // Include updated watchers
            }),
          });

          if (!editResponse.ok) {
            const errorData = await editResponse.json();
            throw new Error(errorData.error || 'Failed to save changes');
          }
        } else {
          // Regular update for non-approver edits (creator editing draft)
          // Always save even if no field changes detected (approvers/watchers might have changed)
          const baseApproversForEdit = [
            selectedApprovers.corporate_hod,
            selectedApprovers.finance_manager,
            selectedApprovers.general_manager,
            selectedApprovers.procurement_manager,
            selectedApprovers.managing_director,
            selectedApprovers.finance_director,
            selectedApprovers.ceo,
          ].filter(Boolean);
          const approversArray = (requiresMdApproval && mdApproverId)
            ? [mdApproverId, ...baseApproversForEdit.filter(id => id !== mdApproverId)]
            : baseApproversForEdit;

          const updatePayload = {
            title: `CAPEX: ${formData.projectName}`,
            description: formData.description,
            metadata: {
              type: 'capex',
              referenceCode: existingReferenceCode || referenceCode || undefined,
              requester: formData.requester,
              unit: formData.unit,
              department: formData.department,
              projectName: formData.projectName,
              description: formData.description,
              budgetType: formData.budgetType,
              isBudgeted: formData.isBudgeted !== false,
              budgetAmount: isBudgetedCapex ? formData.budgetAmount : '',
              amountSpent: isBudgetedCapex ? formData.amountSpent : '',
              budgetBalance: isBudgetedCapex ? budgetBalanceDisplay : '',
              amount: formData.amount,
              currency: formData.currency,
              justification: formData.justification,
              paybackPeriod: formData.paybackPeriod,
              npv: formData.npv,
              irr: formData.irr,
              fundingSource: formData.fundingSource,
              evaluation: formData.evaluation,
              startDate: formData.startDate,
              endDate: formData.endDate,
              priority: formData.priority,
              allowMultipleSuppliers,
              approvers: approversArray,
              approverRoles: selectedApprovers,
              useParallelApprovals: useParallelApprovals,
              watchers: Array.isArray(selectedWatchers) ? selectedWatchers.map(w => typeof w === 'string' ? w : w.id) : [],
              quotations: [
                ...(Array.isArray(existingQuotations) ? existingQuotations : []),
                ...quotationDocuments.map(doc => ({
                  name: doc.file.name,
                  size: doc.file.size,
                  type: doc.file.type,
                  description: doc.description,
                  supplierName: doc.supplierName,
                  amount: doc.amount,
                  sourcedAmount: doc.sourcedAmount || '',
                  isSelectedSupplier: doc.isSelectedSupplier,
                  selectionReason: doc.selectionReason,
                  uploadedBy: {
                    id: user?.id || session?.user?.id,
                    name: user?.display_name || session?.user?.name || 'Unknown',
                    isApprover: isApproverEditing,
                  },
                  uploadedAt: new Date().toISOString(),
                })),
              ],
              supportingDocuments: [
                ...(Array.isArray(existingSupportingDocs) ? existingSupportingDocs : []),
                ...supportingDocuments.map(doc => ({
                  name: doc.file.name,
                  size: doc.file.size,
                  type: doc.file.type,
                  description: doc.description,
                  uploadedBy: {
                    id: user?.id || session?.user?.id,
                    name: user?.display_name || session?.user?.name || 'Unknown',
                    isApprover: isApproverEditing,
                  },
                  uploadedAt: new Date().toISOString(),
                })),
              ],
              comparativeAnalysis: [
                ...(Array.isArray(existingComparativeAnalysis) ? existingComparativeAnalysis : []),
                ...comparativeAnalysisDocuments.map(doc => ({
                  name: doc.file.name,
                  size: doc.file.size,
                  type: doc.file.type,
                  description: doc.description,
                  uploadedBy: {
                    id: user?.id || session?.user?.id,
                    name: user?.display_name || session?.user?.name || 'Unknown',
                    isApprover: isApproverEditing,
                  },
                  uploadedAt: new Date().toISOString(),
                })),
              ],
              quotationJustification: quotationJustification || null,
              quotationReason: quotationReason || null,
              cooApprovalRequired: requiresMdApproval,
              mdApproverId: requiresMdApproval ? (mdApproverId || null) : null,
            },
          };

          const updateResponse = await fetch(`/api/requests/${editRequestId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(updatePayload),
          });

          if (!updateResponse.ok) {
            const errorText = await updateResponse.text();
            console.error('Update response error:', errorText);
            let errorMessage = 'Failed to update request';
            try {
              const errorData = JSON.parse(errorText);
              errorMessage = errorData.error || errorMessage;
            } catch (e) {
              errorMessage = errorText || errorMessage;
            }
            throw new Error(errorMessage);
          }
        }

        // Delete any documents the user removed while editing (best-effort).
        for (const docId of removedDocumentIds) {
          try {
            await fetch(`/api/requests/${editRequestId}/documents?documentId=${docId}`, { method: 'DELETE' });
          } catch (delErr) {
            console.error(`Failed to delete removed document ${docId}:`, delErr);
          }
        }

        // Upload any new documents
        if (quotationDocuments.length > 0) {
          for (const doc of quotationDocuments) {
            const uploadFormData = new FormData();
            uploadFormData.append('file', doc.file);
            uploadFormData.append('documentType', 'quotation');

            try {
              const endpoint = isApproverEditing 
                ? `/api/requests/${editRequestId}/approver-documents`
                : `/api/requests/${editRequestId}/documents`;
              
              const uploadResponse = await fetch(endpoint, {
                method: 'POST',
                body: uploadFormData,
              });

              if (!uploadResponse.ok) {
                console.error(`Failed to upload quotation: ${doc.file.name}`);
              }
            } catch (uploadErr) {
              console.error(`Error uploading quotation ${doc.file.name}:`, uploadErr);
            }
          }
        }

        if (comparativeAnalysisDocuments.length > 0) {
          for (const doc of comparativeAnalysisDocuments) {
            const uploadFormData = new FormData();
            uploadFormData.append('file', doc.file);
            uploadFormData.append('documentType', 'comparative_analysis');

            try {
              const endpoint = isApproverEditing
                ? `/api/requests/${editRequestId}/approver-documents`
                : `/api/requests/${editRequestId}/documents`;

              const uploadResponse = await fetch(endpoint, {
                method: 'POST',
                body: uploadFormData,
              });

              if (!uploadResponse.ok) {
                console.error(`Failed to upload comparative analysis: ${doc.file.name}`);
              }
            } catch (uploadErr) {
              console.error(`Error uploading comparative analysis ${doc.file.name}:`, uploadErr);
            }
          }
        }

        if (supportingDocuments.length > 0) {
          for (const doc of supportingDocuments) {
            const uploadFormData = new FormData();
            uploadFormData.append('file', doc.file);
            uploadFormData.append('documentType', 'supporting');

            try {
              const endpoint = isApproverEditing
                ? `/api/requests/${editRequestId}/approver-documents`
                : `/api/requests/${editRequestId}/documents`;

              const uploadResponse = await fetch(endpoint, {
                method: 'POST',
                body: uploadFormData,
              });

              if (!uploadResponse.ok) {
                console.error(`Failed to upload supporting document: ${doc.file.name}`);
              }
            } catch (uploadErr) {
              console.error(`Error uploading supporting document ${doc.file.name}:`, uploadErr);
            }
          }
        }

        // Show success toast
        addToast({
          type: 'success',
          title: 'Changes Saved',
          message: isApproverEditing 
            ? 'Your changes have been saved and tracked.' 
            : 'Request updated successfully.',
        });

        // Navigate back to the request details page
        router.push(`/requests/${editRequestId}`);
        return;
      }

      // Create new request (original flow)
      // Convert approvers object to ordered array for sequential approval
      // Order: Finance Manager -> General Manager -> Procurement and Projects Manager -> Corporate HOD -> Operations Director -> Finance Director -> CEO
      // If "Other" reason was given for <3 quotations, the COO is prepended as the first approver
      // so the request cannot move into the official approval trail until the COO signs off.
      const baseApprovers = [
        selectedApprovers.corporate_hod,
        selectedApprovers.finance_manager,
        selectedApprovers.general_manager,
        selectedApprovers.procurement_manager,
        selectedApprovers.managing_director,
        selectedApprovers.finance_director,
        selectedApprovers.ceo,
      ].filter(Boolean);
      const approversArray = (requiresMdApproval && mdApproverId)
        ? [mdApproverId, ...baseApprovers.filter(id => id !== mdApproverId)]
        : baseApprovers;

      const response = await fetch('/api/requests', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: `CAPEX: ${formData.projectName}`,
          description: formData.description,
          priority: formData.priority || 'medium',
          requestType: 'capex',
          status: isDraft ? 'draft' : 'pending',
          metadata: {
            type: 'capex',
            requester: formData.requester,
            unit: formData.unit,
            department: formData.department,
            projectName: formData.projectName,
            description: formData.description,
            budgetType: formData.budgetType,
            isBudgeted: formData.isBudgeted !== false,
            budgetAmount: isBudgetedCapex ? formData.budgetAmount : '',
            amountSpent: isBudgetedCapex ? formData.amountSpent : '',
            budgetBalance: isBudgetedCapex ? budgetBalanceDisplay : '',
            amount: formData.amount,
            currency: formData.currency,
            justification: formData.justification,
            paybackPeriod: formData.paybackPeriod,
            npv: formData.npv,
            irr: formData.irr,
            fundingSource: formData.fundingSource,
            evaluation: formData.evaluation,
            startDate: formData.startDate,
            endDate: formData.endDate,
            priority: formData.priority,
            allowMultipleSuppliers,
            approvers: approversArray, // Sequential array of approver IDs
            approverRoles: selectedApprovers, // Keep original object for reference
            useParallelApprovals: useParallelApprovals, // Parallel or sequential approval mode
            onBehalfOf: onBehalfOf || null,
            watchers: selectedWatchers,
            quotations: quotationDocuments.map(doc => ({
              name: doc.file.name,
              size: doc.file.size,
              type: doc.file.type,
              description: doc.description,
              supplierName: doc.supplierName,
              amount: doc.amount,
              sourcedAmount: doc.sourcedAmount || '',
              isSelectedSupplier: doc.isSelectedSupplier,
              selectionReason: doc.selectionReason,
              uploadedBy: {
                id: user?.id || session?.user?.id,
                name: user?.display_name || session?.user?.name || 'Unknown',
                isApprover: false,
              },
              uploadedAt: new Date().toISOString(),
            })),
            supportingDocuments: supportingDocuments.map(doc => ({
              name: doc.file.name,
              size: doc.file.size,
              type: doc.file.type,
              description: doc.description,
              uploadedBy: {
                id: user?.id || session?.user?.id,
                name: user?.display_name || session?.user?.name || 'Unknown',
                isApprover: false,
              },
              uploadedAt: new Date().toISOString(),
            })),
            comparativeAnalysis: comparativeAnalysisDocuments.map(doc => ({
              name: doc.file.name,
              size: doc.file.size,
              type: doc.file.type,
              description: doc.description,
              uploadedBy: {
                id: user?.id || session?.user?.id,
                name: user?.display_name || session?.user?.name || 'Unknown',
                isApprover: false,
              },
              uploadedAt: new Date().toISOString(),
            })),
            quotationJustification: quotationJustification || null,
            quotationReason: quotationReason || null,
            cooApprovalRequired: requiresMdApproval,
            mdApproverId: requiresMdApproval ? (mdApproverId || null) : null,
          },
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || `Failed to ${isDraft ? 'save draft' : 'create CAPEX request'}`);
      }

      const requestId = data.request?.id;

      // Upload quotation documents
      if (requestId && quotationDocuments.length > 0) {
        for (const doc of quotationDocuments) {
          const uploadFormData = new FormData();
          uploadFormData.append('file', doc.file);
          uploadFormData.append('documentType', 'quotation');

          try {
            const uploadResponse = await fetch(`/api/requests/${requestId}/documents`, {
              method: 'POST',
              body: uploadFormData,
            });

            if (!uploadResponse.ok) {
              console.error(`Failed to upload quotation: ${doc.file.name}`);
            }
          } catch (uploadErr) {
            console.error(`Error uploading quotation ${doc.file.name}:`, uploadErr);
          }
        }
      }

      // Upload comparative analysis documents
      if (requestId && comparativeAnalysisDocuments.length > 0) {
        for (const doc of comparativeAnalysisDocuments) {
          const uploadFormData = new FormData();
          uploadFormData.append('file', doc.file);
          uploadFormData.append('documentType', 'comparative_analysis');

          try {
            const uploadResponse = await fetch(`/api/requests/${requestId}/documents`, {
              method: 'POST',
              body: uploadFormData,
            });

            if (!uploadResponse.ok) {
              console.error(`Failed to upload comparative analysis: ${doc.file.name}`);
            }
          } catch (uploadErr) {
            console.error(`Error uploading comparative analysis ${doc.file.name}:`, uploadErr);
          }
        }
      }

      // Upload supporting documents
      if (requestId && supportingDocuments.length > 0) {
        for (const doc of supportingDocuments) {
          const uploadFormData = new FormData();
          uploadFormData.append('file', doc.file);
          uploadFormData.append('documentType', 'supporting');

          try {
            const uploadResponse = await fetch(`/api/requests/${requestId}/documents`, {
              method: 'POST',
              body: uploadFormData,
            });

            if (!uploadResponse.ok) {
              console.error(`Failed to upload supporting document: ${doc.file.name}`);
            }
          } catch (uploadErr) {
            console.error(`Error uploading supporting document ${doc.file.name}:`, uploadErr);
          }
        }
      }

      // Show success toast
      if (isDraft) {
        addToast({
          type: 'success',
          title: 'Draft Saved',
          message: 'Your CAPEX request has been saved as a draft.',
        });
      } else {
        addToast({
          type: 'success',
          title: 'Request Submitted',
          message: 'Your CAPEX request has been submitted for approval.',
        });
      }

      router.push('/requests/my-requests');
    } catch (err: any) {
      const msg = err.message || `Failed to ${isDraft ? 'save draft' : 'create CAPEX request'}`;
      setError(msg);
      addToast({
        type: 'error',
        title: isDraft ? "Couldn't save draft" : "Couldn't submit request",
        message: msg,
        duration: 8000,
      });
    } finally {
      setLoading(false);
      setSavingDraft(false);
    }
  };

  // Preserve in-progress decimals so cents can be typed (e.g. "1,234.50").
  // See lib/money formatMoneyInput — reformatting with parseFloat on every
  // keystroke used to swallow the decimal point.
  const formatCurrency = (value: string) => formatMoneyInput(value);

  // Parse a display-formatted currency string ("1,250.00") back to a number.
  const parseCurrency = (value: string) => {
    const num = parseFloat((value || '').replace(/[^0-9.]/g, ''));
    return isNaN(num) ? 0 : num;
  };

  // Symbol shown in front of amounts for the selected currency.
  const currencySymbol = (curr?: string) => (curr === 'ZIG' ? 'ZiG' : curr === 'ZAR' ? 'R' : '$');

  // ---- Multiple-suppliers helpers -----------------------------------------
  // The quotations the user flagged as selected suppliers (across both the
  // edit-mode existing quotations and the newly-uploaded ones). Used for the
  // read-only summary and to auto-total the Project Cost in multi mode.
  // `quoteAmount` is the full quotation total; `sourcedAmount` is the value of
  // the items actually being bought from that quotation. When a sourced amount
  // isn't given we fall back to the full quotation total.
  const selectedSupplierQuotes: Array<{ supplier: string; description: string; quoteAmount: string; sourcedAmount: string }> = [
    ...(Array.isArray(existingQuotations) ? existingQuotations : [])
      .filter((q: any) => q.isSelectedSupplier)
      .map((q: any) => ({ supplier: q.supplierName || '', description: q.description || '', quoteAmount: q.amount || '', sourcedAmount: q.sourcedAmount || '' })),
    ...quotationDocuments
      .filter(d => d.isSelectedSupplier)
      .map(d => ({ supplier: d.supplierName || '', description: d.description || '', quoteAmount: d.amount || '', sourcedAmount: d.sourcedAmount || '' })),
  ];
  const sourcedValueOf = (q: { quoteAmount: string; sourcedAmount: string }) =>
    q.sourcedAmount && q.sourcedAmount.trim() ? parseCurrency(q.sourcedAmount) : parseCurrency(q.quoteAmount);
  const selectedSuppliersTotal = selectedSupplierQuotes.reduce((sum, q) => sum + sourcedValueOf(q), 0);

  // Keep the Project Cost in step with the selected suppliers while multi mode
  // is on. The field is read-only in this mode, so it always mirrors the sum of
  // the selected quotations' amounts.
  useEffect(() => {
    if (!allowMultipleSuppliers) return;
    setFormData(prev => ({ ...prev, amount: formatMoneyInput(selectedSuppliersTotal.toFixed(2)) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowMultipleSuppliers, selectedSuppliersTotal]);

  // Budgeted CAPEX only: balance remaining once this project's cost is drawn
  // down against the approved budget line = budget − already spent − this project.
  const isBudgetedCapex = formData.budgetType === 'budget';
  const budgetBalanceAfterProject =
    parseCurrency(formData.budgetAmount) - parseCurrency(formData.amountSpent) - parseCurrency(formData.amount);
  // formatCurrency strips the minus sign, so preserve it explicitly for the balance.
  const budgetBalanceDisplay =
    `${budgetBalanceAfterProject < 0 ? '-' : ''}${formatCurrency(String(Math.abs(budgetBalanceAfterProject)))}`;

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

  const handlePublish = async () => {
    if (!editRequestId || typeof editRequestId !== 'string') return;
    
    setPublishing(true);
    setError(null);
    
    try {
      // First, save any changes to the draft
      const basePublishApprovers = [
        selectedApprovers.corporate_hod,
        selectedApprovers.finance_manager,
        selectedApprovers.general_manager,
        selectedApprovers.procurement_manager,
        selectedApprovers.managing_director,
        selectedApprovers.finance_director,
        selectedApprovers.ceo,
      ].filter(Boolean);
      const approversArray = (requiresMdApproval && mdApproverId)
        ? [mdApproverId, ...basePublishApprovers.filter(id => id !== mdApproverId)]
        : basePublishApprovers;

      // Update the request with current form data before publishing
      const updateResponse = await fetch(`/api/requests/${editRequestId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: `CAPEX: ${formData.projectName}`,
          description: formData.description,
          metadata: {
            type: 'capex',
            requester: formData.requester,
            unit: formData.unit,
            department: formData.department,
            projectName: formData.projectName,
            description: formData.description,
            budgetType: formData.budgetType,
            isBudgeted: formData.isBudgeted !== false,
            budgetAmount: isBudgetedCapex ? formData.budgetAmount : '',
            amountSpent: isBudgetedCapex ? formData.amountSpent : '',
            budgetBalance: isBudgetedCapex ? budgetBalanceDisplay : '',
            amount: formData.amount,
            currency: formData.currency,
            justification: formData.justification,
            paybackPeriod: formData.paybackPeriod,
            npv: formData.npv,
            irr: formData.irr,
            fundingSource: formData.fundingSource,
            evaluation: formData.evaluation,
            startDate: formData.startDate,
            endDate: formData.endDate,
            priority: formData.priority,
            allowMultipleSuppliers,
            approvers: approversArray,
            approverRoles: selectedApprovers,
            useParallelApprovals: useParallelApprovals,
            watchers: selectedWatchers.map(w => typeof w === 'string' ? w : w.id),
            quotations: [
              ...existingQuotations,
              ...quotationDocuments.map(doc => ({
                name: doc.file.name,
                size: doc.file.size,
                type: doc.file.type,
                description: doc.description,
                supplierName: doc.supplierName,
                amount: doc.amount,
                sourcedAmount: doc.sourcedAmount || '',
                isSelectedSupplier: doc.isSelectedSupplier,
                selectionReason: doc.selectionReason,
                uploadedBy: {
                  id: user?.id || session?.user?.id,
                  name: user?.display_name || session?.user?.name || 'Unknown',
                  isApprover: false,
                },
                uploadedAt: new Date().toISOString(),
              })),
            ],
            supportingDocuments: [
              ...existingSupportingDocs,
              ...supportingDocuments.map(doc => ({
                name: doc.file.name,
                size: doc.file.size,
                type: doc.file.type,
                description: doc.description,
                uploadedBy: {
                  id: user?.id || session?.user?.id,
                  name: user?.display_name || session?.user?.name || 'Unknown',
                  isApprover: false,
                },
                uploadedAt: new Date().toISOString(),
              })),
            ],
            comparativeAnalysis: [
              ...existingComparativeAnalysis,
              ...comparativeAnalysisDocuments.map(doc => ({
                name: doc.file.name,
                size: doc.file.size,
                type: doc.file.type,
                description: doc.description,
                uploadedBy: {
                  id: user?.id || session?.user?.id,
                  name: user?.display_name || session?.user?.name || 'Unknown',
                  isApprover: false,
                },
                uploadedAt: new Date().toISOString(),
              })),
            ],
            quotationJustification: quotationJustification || null,
            quotationReason: quotationReason || null,
            cooApprovalRequired: requiresMdApproval,
            mdApproverId: requiresMdApproval ? (mdApproverId || null) : null,
          },
        }),
      });

      if (!updateResponse.ok) {
        const errorData = await updateResponse.json();
        throw new Error(errorData.error || 'Failed to save changes before publishing');
      }

      // Delete any documents the user removed while editing (best-effort).
      for (const docId of removedDocumentIds) {
        try {
          await fetch(`/api/requests/${editRequestId}/documents?documentId=${docId}`, { method: 'DELETE' });
        } catch (delErr) {
          console.error(`Failed to delete removed document ${docId}:`, delErr);
        }
      }

      // Upload any new documents
      if (quotationDocuments.length > 0) {
        for (const doc of quotationDocuments) {
          const uploadFormData = new FormData();
          uploadFormData.append('file', doc.file);
          uploadFormData.append('documentType', 'quotation');
          await fetch(`/api/requests/${editRequestId}/documents`, {
            method: 'POST',
            body: uploadFormData,
          });
        }
      }

      if (comparativeAnalysisDocuments.length > 0) {
        for (const doc of comparativeAnalysisDocuments) {
          const uploadFormData = new FormData();
          uploadFormData.append('file', doc.file);
          uploadFormData.append('documentType', 'comparative_analysis');
          await fetch(`/api/requests/${editRequestId}/documents`, {
            method: 'POST',
            body: uploadFormData,
          });
        }
      }

      if (supportingDocuments.length > 0) {
        for (const doc of supportingDocuments) {
          const uploadFormData = new FormData();
          uploadFormData.append('file', doc.file);
          uploadFormData.append('documentType', 'supporting');
          await fetch(`/api/requests/${editRequestId}/documents`, {
            method: 'POST',
            body: uploadFormData,
          });
        }
      }

      // Now publish the request
      const publishResponse = await fetch(`/api/requests/${editRequestId}/publish`, {
        method: 'POST',
      });

      if (!publishResponse.ok) {
        const errorData = await publishResponse.json();
        throw new Error(errorData.error || 'Failed to publish request');
      }

      addToast({
        type: 'success',
        title: 'Request Published',
        message: 'Your CAPEX request has been submitted for approval.',
      });

      setShowPublishModal(false);
      router.push(`/requests/${editRequestId}`);
    } catch (err: any) {
      console.error('Error publishing request:', err);
      setError(err.message || 'Failed to publish request');
      addToast({
        type: 'error',
        title: 'Publish Failed',
        message: err.message || 'Failed to publish request',
      });
    } finally {
      setPublishing(false);
    }
  };

  if (status === 'loading' || loadingRequest) {
    return (
      <AppLayout title={isEditMode ? "Edit CAPEX Request" : "CAPEX Request"} showBack onBack={() => router.back()}>
        <div className="flex items-center justify-center min-h-[60vh]">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-500" />
        </div>
      </AppLayout>
    );
  }

  if (!session) return null;

  return (
    <AppLayout title={isEditMode ? "Edit CAPEX Request" : "CAPEX Request"} showBack onBack={() => router.back()} hideNav>
      <form onSubmit={handleSubmit} onChange={() => setIsDirty(true)} className="p-4 sm:p-6 space-y-6 max-w-5xl mx-auto pb-28">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-bold text-text-primary font-heading uppercase tracking-wide">
            {isApproverEditing
              ? 'Edit Capex Request'
              : isEditMode
                ? 'Edit Capex Request'
                : 'Capital Expenditure Request'}
          </h1>
          <p className="text-sm text-gray-500 mt-1">DOC NO. FIN 101 — DEPARTMENT: FINANCE</p>
          <div className="mt-4 max-w-lg mx-auto">
            <ReferenceCodeBanner
              requestType="capex"
              existingCode={existingReferenceCode}
              onCodeAssigned={setReferenceCode}
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
          <Card className="bg-danger-50 border-danger-200">
            <p className="text-danger-600 text-sm">{error}</p>
          </Card>
        )}

        {/* Filing on behalf of — shown at the top; only assigned assistants see it */}
        <Card>
          <OnBehalfOfField value={onBehalfOf} onChange={setOnBehalfOf} />
        </Card>

        {/* General Information */}
        <Card>
          <h3 className="font-semibold text-text-primary mb-4 flex items-center gap-2 text-lg">
            <svg className="w-5 h-5 text-primary-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
            </svg>
            General Information
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div data-field="requester">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Requester <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                className={`w-full px-4 py-2 min-h-[44px] rounded-xl border bg-gray-50 text-gray-500 cursor-not-allowed focus:outline-none transition-all ${fieldErrors.requester ? 'border-red-500' : 'border-gray-300'}`}
                placeholder="Requester Name"
                value={formData.requester}
                readOnly
                disabled
              />
              {fieldErrors.requester && <p className="mt-1 text-sm text-red-500">{fieldErrors.requester}</p>}
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Business Unit <span className="text-red-500">*</span>
              </label>
              {user?.business_unit_id ? (
                <input
                  type="text"
                  className="w-full px-4 py-2 min-h-[44px] rounded-xl border border-gray-300 bg-gray-50 text-gray-500 cursor-not-allowed focus:outline-none transition-all"
                  value={businessUnitName || formData.unit || 'Loading...'}
                  readOnly
                  disabled
                />
              ) : (
                <select
                  className="w-full px-4 py-2 min-h-[44px] rounded-xl border border-gray-300 bg-white text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-all"
                  value={formData.unit}
                  onChange={(e) => setFormData({ ...formData, unit: e.target.value })}
                  required
                >
                  <option value="">{loadingUnits ? 'Loading...' : 'Select business unit'}</option>
                  {businessUnits.map((unit) => (
                    <option key={unit.id} value={unit.name}>{unit.name}</option>
                  ))}
                </select>
              )}
              {!user?.business_unit_id && (
                <p className="text-xs text-amber-600 mt-1">Please select your business unit</p>
              )}
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Department <span className="text-red-500">*</span>
              </label>
              {user?.department_id ? (
                <input
                  type="text"
                  className="w-full px-4 py-2 min-h-[44px] rounded-xl border border-gray-300 bg-gray-50 text-gray-500 cursor-not-allowed focus:outline-none transition-all"
                  value={departmentName || formData.department || 'Loading...'}
                  readOnly
                  disabled
                />
              ) : (
                <select
                  className="w-full px-4 py-2 min-h-[44px] rounded-xl border border-gray-300 bg-white text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-all"
                  value={formData.department}
                  onChange={(e) => setFormData({ ...formData, department: e.target.value })}
                  required
                >
                  <option value="">{loadingDepartments ? 'Loading...' : 'Select department'}</option>
                  {departments.map((dept) => (
                    <option key={dept.id} value={dept.name}>{dept.name}</option>
                  ))}
                </select>
              )}
              {!user?.department_id && (
                <p className="text-xs text-amber-600 mt-1">Please select your department</p>
              )}
            </div>
            <div data-field="budgetType">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Budget Type <span className="text-red-500">*</span>
              </label>
              <select
                className={`w-full px-4 py-2 min-h-[44px] rounded-xl border bg-white text-gray-900 focus:outline-none focus:ring-2 focus:border-transparent transition-all ${fieldErrors.budgetType ? 'border-red-500 focus:ring-red-500' : 'border-gray-300 focus:ring-primary-500'}`}
                value={formData.budgetType}
                onChange={(e) => { setFormData({ ...formData, budgetType: e.target.value }); clearFieldError('budgetType'); }}
                required
              >
                <option value="">Select type</option>
                <option value="budget">Budgeted</option>
                <option value="non-budget">Non-Budgeted</option>
                <option value="emergency">Emergency</option>
              </select>
              {fieldErrors.budgetType && <p className="mt-1 text-sm text-red-500">{fieldErrors.budgetType}</p>}
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Priority / Urgency Level
              </label>
              <select
                className="w-full px-4 py-2 min-h-[44px] rounded-xl border border-gray-300 bg-white text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-all"
                value={formData.priority}
                onChange={(e) => setFormData({ ...formData, priority: e.target.value })}
              >
                <option value="">Select priority</option>
                <option value="low">Low - Can wait</option>
                <option value="medium">Medium - Standard timeline</option>
                <option value="high">High - Urgent</option>
                <option value="critical">Critical - Immediate attention</option>
              </select>
            </div>
          </div>
        </Card>

        {/* Project Details */}
        <Card>
          <h3 className="font-semibold text-text-primary mb-4 flex items-center gap-2 text-lg">
            <svg className="w-5 h-5 text-warning-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
            </svg>
            Project Details
          </h3>
          <div className="space-y-4">
            <div data-field="projectName">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Project Name / Description <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                className={`w-full px-4 py-2 min-h-[44px] rounded-xl border bg-white text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:border-transparent transition-all ${fieldErrors.projectName ? 'border-red-500 focus:ring-red-500' : 'border-gray-300 focus:ring-primary-500'}`}
                placeholder="Enter short project name"
                value={formData.projectName}
                onChange={(e) => { setFormData({ ...formData, projectName: e.target.value }); clearFieldError('projectName'); }}
                required
              />
              {fieldErrors.projectName && <p className="mt-1 text-sm text-red-500">{fieldErrors.projectName}</p>}
            </div>
            {/* Keeping separate description if they want more detail, otherwise projectName covers 'Description' requested. 
                The user asked for 'Description', so combining name/short desc into one or keeping separate. 
                I will keep a detailed description box as well. */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Detailed Description (Optional)
              </label>
              <textarea
                className="w-full px-4 py-3 min-h-[100px] rounded-xl border border-gray-300 bg-white text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent resize-none transition-all"
                placeholder="Describe the project scope and details..."
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
              />
            </div>
            <div data-field="justification">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Business Justification <span className="text-red-500">*</span>
              </label>
              <textarea
                className={`w-full px-4 py-3 min-h-[100px] rounded-xl border bg-white text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:border-transparent resize-none transition-all ${fieldErrors.justification ? 'border-red-500 focus:ring-red-500' : 'border-gray-300 focus:ring-primary-500'}`}
                placeholder="Explain the business, expected benefits and why you chose the quotation you chose..."
                value={formData.justification}
                onChange={(e) => { setFormData({ ...formData, justification: e.target.value }); clearFieldError('justification'); }}
                required
              />
              {fieldErrors.justification && <p className="mt-1 text-sm text-red-500">{fieldErrors.justification}</p>}
            </div>
          </div>
        </Card>

        {/* Quotations Section - Required */}
        <Card data-field="quotations">
          <h3 className="font-semibold text-text-primary mb-3 flex items-center gap-2 text-lg">
            <svg className="w-5 h-5 text-danger-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            Quotations
            {!isEditMode && <span className="ml-2 px-2 py-0.5 text-xs font-medium bg-danger-100 text-danger-700 rounded-full">Required</span>}
            <span className="ml-auto text-sm font-normal text-gray-500">
              ({existingQuotations.length + quotationDocuments.length} uploaded{!isEditMode ? ' · 3 recommended' : ''})
            </span>
          </h3>
          <p className="text-sm text-gray-600 mb-4">
            {isEditMode
              ? 'You can upload additional quotations if needed.'
              : 'The standard is 3 quotations from different suppliers, but you may upload more. Each quotation should include supplier details.'}
          </p>

          {/* Multiple-suppliers toggle — when on, more than one quotation can be
              marked as a selected supplier and their amounts are summed into the
              Project Cost (which then becomes read-only). */}
          <label className="flex items-start gap-3 mb-4 p-3 rounded-xl border border-gray-200 bg-gray-50 cursor-pointer">
            <input
              type="checkbox"
              className="mt-0.5 w-4 h-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
              checked={allowMultipleSuppliers}
              onChange={(e) => { setAllowMultipleSuppliers(e.target.checked); setIsDirty(true); }}
            />
            <span>
              <span className="block text-sm font-medium text-gray-800">Select multiple suppliers for this CAPEX</span>
              <span className="block text-xs text-gray-500 mt-0.5">
                Turn this on when the CAPEX is sourced from more than one supplier. Tick each supplier&apos;s quotation below —
                their amounts are added up and auto-populated into the total Project Cost.
              </span>
            </span>
          </label>

          {(fieldErrors.quotations || fieldErrors.quotationReason) && (
            <div className="mb-4 p-3 rounded-xl bg-red-50 border border-red-200 text-sm text-red-600">
              {fieldErrors.quotations || fieldErrors.quotationReason}
            </div>
          )}

          {/* Existing Quotations (in edit mode) — editable + removable */}
          {isEditMode && existingQuotations.length > 0 && (
            <div className="mb-4 space-y-3">
              <h4 className="text-sm font-medium text-gray-700">Existing Quotations:</h4>
              {existingQuotations.map((quotation: any, index: number) => (
                <div key={index} className={`p-4 rounded-xl border transition-all space-y-4 ${quotation.isSelectedSupplier ? 'bg-emerald-50 border-emerald-200' : 'bg-gray-50 border-gray-200'}`}>
                  <div className="flex items-start gap-3">
                    <div className={`w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 ${quotation.isSelectedSupplier ? 'bg-emerald-100' : 'bg-gray-100'}`}>
                      <svg className={`w-5 h-5 ${quotation.isSelectedSupplier ? 'text-emerald-600' : 'text-gray-500'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                      </svg>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-gray-900 text-sm truncate">{quotation.name}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleRemoveExistingQuotation(index)}
                      className="flex-shrink-0 p-1.5 rounded-lg hover:bg-danger-50 text-gray-400 hover:text-danger-500 transition-colors"
                      title="Remove quotation"
                    >
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Supplier Name</label>
                      <input
                        type="text"
                        autoComplete="off"
                        className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 bg-white text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-all"
                        placeholder="e.g., ABC Suppliers Ltd"
                        value={quotation.supplierName || ''}
                        onChange={(e) => handleUpdateExistingQuotation(index, 'supplierName', e.target.value)}
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Quotation Amount</label>
                      <div className="relative">
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 text-sm">{formData.currency === 'ZIG' ? 'ZiG' : formData.currency === 'ZAR' ? 'R' : '$'}</span>
                        <input
                          type="text"
                          inputMode="decimal"
                          className="w-full pl-7 pr-3 py-2 text-sm rounded-lg border border-gray-300 bg-white text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-all"
                          placeholder="0.00"
                          value={quotation.amount || ''}
                          onChange={(e) => handleUpdateExistingQuotation(index, 'amount', formatCurrency(e.target.value))}
                        />
                      </div>
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Quotation Description</label>
                    <input
                      type="text"
                      className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 bg-white text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-all"
                      placeholder="e.g., Quotation for office equipment"
                      value={quotation.description || ''}
                      onChange={(e) => handleUpdateExistingQuotation(index, 'description', e.target.value)}
                    />
                  </div>

                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      className="w-4 h-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                      checked={!!quotation.isSelectedSupplier}
                      onChange={(e) => handleUpdateExistingQuotation(index, 'isSelectedSupplier', e.target.checked)}
                    />
                    <span className="text-sm font-medium text-gray-700">{allowMultipleSuppliers ? 'Include this supplier in the CAPEX' : 'This is the selected supplier'}</span>
                  </label>

                  {quotation.isSelectedSupplier && allowMultipleSuppliers && (
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">
                        Order Value <span className="text-danger-500">*</span>
                      </label>
                      <div className="relative">
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 text-sm">{currencySymbol(formData.currency)}</span>
                        <input
                          type="text"
                          inputMode="decimal"
                          className="w-full pl-7 pr-3 py-2 text-sm rounded-lg border border-gray-300 bg-white text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-all"
                          placeholder="0.00"
                          value={quotation.sourcedAmount || ''}
                          onChange={(e) => handleUpdateExistingQuotation(index, 'sourcedAmount', formatCurrency(e.target.value))}
                        />
                      </div>
                      <p className="mt-1 text-xs text-gray-500">
                        Value of the items you&apos;re buying from this supplier — this is what&apos;s summed into the Project Cost.
                        Full quotation total: {currencySymbol(formData.currency)} {quotation.amount || '0.00'}.
                      </p>
                    </div>
                  )}

                  {quotation.isSelectedSupplier && (
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Why was this supplier selected?</label>
                      <textarea
                        className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 bg-white text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent resize-none transition-all"
                        placeholder="Explain why this supplier was chosen over others..."
                        rows={2}
                        value={quotation.selectionReason || ''}
                        onChange={(e) => handleUpdateExistingQuotation(index, 'selectionReason', e.target.value)}
                      />
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          <input
            type="file"
            id="quotation-upload"
            className="hidden"
            multiple
            accept=".pdf,.doc,.docx,.xls,.xlsx,.jpg,.jpeg,.png"
            onChange={handleQuotationUpload}
          />

          <label
            htmlFor="quotation-upload"
            className="block border-2 border-dashed rounded-xl p-6 text-center transition-all cursor-pointer group border-danger-200 hover:border-danger-300 hover:bg-danger-50/20"
          >
            <div className="w-10 h-10 bg-danger-50 rounded-full flex items-center justify-center mx-auto mb-2 group-hover:bg-white group-hover:shadow-sm">
              <svg className="w-5 h-5 text-danger-400 group-hover:text-danger-500 transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
              </svg>
            </div>
            <p className="text-sm text-gray-700 font-medium">
              Click to upload quotations
            </p>
            <p className="text-xs text-gray-400 mt-1">PDF, Excel, Word, or Images up to 10MB</p>
          </label>

          {/* Uploaded Quotations List with Metadata */}
          {quotationDocuments.length > 0 && (
            <div className="mt-4 space-y-4">
              <h4 className="text-sm font-medium text-gray-700">Uploaded Quotations:</h4>
              {quotationDocuments.map((doc, index) => (
                <div key={index} className="p-4 bg-gray-50 rounded-xl border border-gray-200 space-y-4">
                  <div className="flex items-start gap-3">
                    <div className="flex-shrink-0 mt-1">
                      <svg className="w-8 h-8 text-danger-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                      </svg>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900 truncate">{doc.file.name}</p>
                      <p className="text-xs text-gray-500">{(doc.file.size / 1024).toFixed(1)} KB</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleRemoveQuotation(index)}
                      className="flex-shrink-0 p-1.5 rounded-lg hover:bg-danger-50 text-gray-400 hover:text-danger-500 transition-colors"
                      title="Remove quotation"
                    >
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div className="relative">
                      <label className="block text-xs font-medium text-gray-600 mb-1">
                        Supplier Name <span className="text-danger-500">*</span>
                      </label>
                      <input
                        type="text"
                        autoComplete="off"
                        className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 bg-white text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-all"
                        placeholder="e.g., ABC Suppliers Ltd"
                        value={doc.supplierName}
                        onChange={(e) => handleUpdateQuotationMetadata(index, 'supplierName', e.target.value)}
                        onFocus={() => setActiveSupplierField(index)}
                        onBlur={() => setActiveSupplierField(null)}
                        required
                      />
                      {/* Suggested suppliers from the directory */}
                      {activeSupplierField === index && (() => {
                        const term = doc.supplierName.trim().toLowerCase();
                        const matches = supplierSuggestions
                          .filter(s => s.name && s.name.toLowerCase() !== term &&
                            (term === '' || s.name.toLowerCase().includes(term)))
                          .slice(0, 8);
                        if (matches.length === 0) return null;
                        return (
                          <div className="absolute z-30 left-0 right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-56 overflow-y-auto">
                            {matches.map(s => (
                              <button
                                key={s.id}
                                type="button"
                                onMouseDown={(e) => {
                                  // onMouseDown (not onClick) so the field's blur
                                  // doesn't close the dropdown before selection.
                                  e.preventDefault();
                                  handleUpdateQuotationMetadata(index, 'supplierName', s.name);
                                  setActiveSupplierField(null);
                                }}
                                className="w-full px-3 py-2 text-left hover:bg-primary-50 transition-colors border-b border-gray-100 last:border-b-0"
                              >
                                <p className="text-sm font-medium text-gray-900 truncate">{s.name}</p>
                                {s.products && (
                                  <p className="text-xs text-gray-500 truncate">{s.products} · {s.currency}</p>
                                )}
                              </button>
                            ))}
                          </div>
                        );
                      })()}
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">
                        Quotation Amount <span className="text-danger-500">*</span>
                      </label>
                      <div className="relative">
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 text-sm">{formData.currency === 'ZIG' ? 'ZiG' : '$'}</span>
                        <input
                          type="text"
                          inputMode="decimal"
                          className="w-full pl-7 pr-3 py-2 text-sm rounded-lg border border-gray-300 bg-white text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-all"
                          placeholder="0.00"
                          value={doc.amount || ''}
                          onChange={(e) => handleUpdateQuotationMetadata(index, 'amount', formatCurrency(e.target.value))}
                        />
                      </div>
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">
                      Quotation Description
                    </label>
                    <input
                      type="text"
                      className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 bg-white text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-all"
                      placeholder="e.g., Quotation for office equipment"
                      value={doc.description}
                      onChange={(e) => handleUpdateQuotationMetadata(index, 'description', e.target.value)}
                    />
                  </div>

                  <div className="flex items-start gap-3">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        className="w-4 h-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                        checked={doc.isSelectedSupplier}
                        onChange={(e) => handleUpdateQuotationMetadata(index, 'isSelectedSupplier', e.target.checked)}
                      />
                      <span className="text-sm font-medium text-gray-700">{allowMultipleSuppliers ? 'Include this supplier in the CAPEX' : 'This is the selected supplier'}</span>
                    </label>
                  </div>

                  {doc.isSelectedSupplier && allowMultipleSuppliers && (
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">
                        Order Value <span className="text-danger-500">*</span>
                      </label>
                      <div className="relative">
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 text-sm">{currencySymbol(formData.currency)}</span>
                        <input
                          type="text"
                          inputMode="decimal"
                          className="w-full pl-7 pr-3 py-2 text-sm rounded-lg border border-gray-300 bg-white text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-all"
                          placeholder="0.00"
                          value={doc.sourcedAmount || ''}
                          onChange={(e) => handleUpdateQuotationMetadata(index, 'sourcedAmount', formatCurrency(e.target.value))}
                        />
                      </div>
                      <p className="mt-1 text-xs text-gray-500">
                        Value of the items you&apos;re buying from this supplier — this is what&apos;s summed into the Project Cost.
                        Full quotation total: {currencySymbol(formData.currency)} {doc.amount || '0.00'}.
                      </p>
                    </div>
                  )}

                  {doc.isSelectedSupplier && (
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">
                        Why was this supplier selected? <span className="text-danger-500">*</span>
                      </label>
                      <textarea
                        className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 bg-white text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent resize-none transition-all"
                        placeholder="Explain why this supplier was chosen over others..."
                        rows={2}
                        value={doc.selectionReason}
                        onChange={(e) => handleUpdateQuotationMetadata(index, 'selectionReason', e.target.value)}
                        required={doc.isSelectedSupplier}
                      />
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Reason for less than 3 quotations — only available once at least 1 quotation is uploaded */}
          {(existingQuotations.length + quotationDocuments.length) >= 1 &&
            (existingQuotations.length + quotationDocuments.length) < 3 && (
            <div className="mt-4 p-4 bg-warning-50 border border-warning-200 rounded-xl space-y-3">
              <div className="flex items-start gap-2">
                <svg className="w-5 h-5 text-warning-600 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                <div className="flex-1">
                  <h4 className="text-sm font-semibold text-warning-800">Reason Required</h4>
                  <p className="text-xs text-warning-700 mt-1">
                    You have uploaded {existingQuotations.length + quotationDocuments.length} quotation(s).
                    Please choose a reason why you cannot provide all 3 required quotations.
                  </p>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-warning-800 mb-1">
                  Reason <span className="text-danger-500">*</span>
                </label>
                <select
                  className="w-full px-4 py-2 min-h-[44px] rounded-xl border border-warning-300 bg-white text-gray-900 focus:outline-none focus:ring-2 focus:ring-warning-500 focus:border-transparent transition-all"
                  value={quotationReason}
                  onChange={(e) => {
                    const v = e.target.value;
                    setQuotationReason(v);
                    if (v !== 'other') {
                      // Clear the MD pre-approval free-text when leaving "Other"
                      setQuotationJustification('');
                    }
                  }}
                  required={(existingQuotations.length + quotationDocuments.length) < 3}
                >
                  <option value="">Select a reason…</option>
                  {QUOTATION_REASONS.map(r => (
                    <option key={r.value} value={r.value}>{r.label}</option>
                  ))}
                </select>
              </div>

              {requiresMdApproval && (
                <div className="space-y-3 rounded-xl border border-danger-200 bg-danger-50/40 p-3">
                  <div className="flex items-start gap-2">
                    <svg className="w-5 h-5 text-danger-600 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01M4.93 19h14.14a2 2 0 001.74-3L13.74 4a2 2 0 00-3.48 0L3.19 16a2 2 0 001.74 3z" />
                    </svg>
                    <div className="flex-1">
                      <h4 className="text-sm font-semibold text-danger-800">COO Pre-Approval Required</h4>
                      <p className="text-xs text-danger-700 mt-1">
                        Because you selected &ldquo;Other&rdquo;, this CAPEX cannot enter the official approval trail until the
                        Chief Operating Officer has reviewed and approved it.
                      </p>
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-danger-800 mb-1">
                      Reason for COO pre-approval <span className="text-danger-500">*</span>
                    </label>
                    <textarea
                      className="w-full px-4 py-3 min-h-[80px] rounded-xl border border-danger-300 bg-white text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-danger-500 focus:border-transparent resize-none transition-all"
                      placeholder="Explain your reason for fewer than 3 quotations…"
                      value={quotationJustification}
                      onChange={(e) => setQuotationJustification(e.target.value)}
                      required={requiresMdApproval}
                    />
                    <p className="text-[11px] text-danger-700 mt-1">
                      This reason is shared with the COO for pre-approval and is not printed on the request form.
                    </p>
                  </div>

                  
                </div>
              )}
            </div>
          )}
          {(existingQuotations.length + quotationDocuments.length) === 0 && (
            <div className="mt-4 p-4 bg-rose-50 border border-rose-200 rounded-xl text-xs text-rose-700">
              Please upload at least 1 quotation. Once you upload a quotation, you may justify submitting fewer than 3.
            </div>
          )}
        </Card>

        {/* Selected Suppliers Summary — read-only recap of the quotations flagged
            as selected suppliers, shown only in multiple-suppliers mode. This is a
            form-only helper; it is intentionally NOT included in the preview/PDF. */}
        {allowMultipleSuppliers && selectedSupplierQuotes.length > 0 && (
          <Card>
            <h3 className="font-semibold text-text-primary mb-1 flex items-center gap-2 text-lg">
              <svg className="w-5 h-5 text-primary-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
              </svg>
              Selected Suppliers Summary
              <span className="ml-2 px-2 py-0.5 text-xs font-medium bg-gray-100 text-gray-600 rounded-full">Read-only</span>
            </h3>
            <p className="text-sm text-gray-600 mb-4">
              A summary of the suppliers you selected from the quotations above. The <span className="font-medium">order value</span> from
              each quotation (not the full quotation total) adds up to the total Project Cost.
            </p>
            <div className="overflow-x-auto rounded-xl border border-gray-200">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                    <th className="px-4 py-2">Supplier</th>
                    <th className="px-4 py-2 text-right">Quotation Total</th>
                    <th className="px-4 py-2 text-right">Order Value</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {selectedSupplierQuotes.map((q, i) => (
                    <tr key={i}>
                      <td className="px-4 py-2 text-gray-900">{q.supplier || '—'}</td>
                      <td className="px-4 py-2 text-gray-700">{q.description || '—'}</td>
                      <td className="px-4 py-2 text-right text-gray-900">
                        {q.amount ? `${formData.currency === 'ZIG' ? 'ZiG' : '$'} ${q.amount}` : '—'}
                      </td>
                    </tr>
                  ))}
                  <tr className="bg-gray-50 font-semibold">
                    <td className="px-4 py-2 text-gray-900" colSpan={2}>Total Project Cost</td>
                    <td className="px-4 py-2 text-right text-gray-900">
                      {formData.currency === 'ZIG' ? 'ZiG' : '$'} {formatMoneyInput(selectedSuppliersTotal.toFixed(2))}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </Card>
        )}

        {/* Comparative Analysis Section — required once 3+ quotations exist */}
        {(() => {
          const totalQuotationsCA = existingQuotations.length + quotationDocuments.length;
          const caRequired = totalQuotationsCA >= 3;
          const caCount = existingComparativeAnalysis.length + comparativeAnalysisDocuments.length;
          return (
        <Card data-field="comparativeAnalysis">
          <h3 className="font-semibold text-text-primary mb-3 flex items-center gap-2 text-lg">
            <svg className={`w-5 h-5 ${caRequired ? 'text-danger-500' : 'text-gray-500'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2" />
            </svg>
            Comparative Analysis
            {caRequired
              ? <span className="ml-2 px-2 py-0.5 text-xs font-medium bg-danger-100 text-danger-700 rounded-full">Required</span>
              : <span className="ml-2 px-2 py-0.5 text-xs font-medium bg-gray-100 text-gray-600 rounded-full">Optional</span>}
            {caCount > 0 && (
              <span className="ml-auto text-sm font-normal text-gray-500">({caCount} uploaded)</span>
            )}
          </h3>
          <p className="text-sm text-gray-600 mb-4">
            {caRequired
              ? 'A comparative analysis of the quotations is required. Upload the document comparing the suppliers you obtained quotations from.'
              : 'A comparative analysis is required once 3 or more quotations are provided. Because you have uploaded fewer than 3 (and given a reason above), it is optional here.'}
          </p>

          {fieldErrors.comparativeAnalysis && (
            <div className="mb-4 p-3 rounded-xl bg-red-50 border border-red-200 text-sm text-red-600">
              {fieldErrors.comparativeAnalysis}
            </div>
          )}

          {/* Existing Comparative Analysis (in edit mode) */}
          {isEditMode && existingComparativeAnalysis.length > 0 && (
            <div className="mb-4 space-y-3">
              <h4 className="text-sm font-medium text-gray-700">Existing Comparative Analysis:</h4>
              {existingComparativeAnalysis.map((doc: any, index: number) => (
                <div key={index} className="p-4 rounded-xl border transition-all bg-[#F3EADC] border-[#C9B896]">
                  <div className="flex items-start gap-3">
                    <div className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 bg-[#F3EADC]">
                      <svg className="w-5 h-5 text-[#9A7545]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2" />
                      </svg>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-gray-900 text-sm">{doc.name}</p>
                      {doc.description && (
                        <p className="text-xs text-gray-500 mt-1">{doc.description}</p>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => handleRemoveExistingComparativeAnalysis(index)}
                      className="flex-shrink-0 p-1.5 rounded-lg hover:bg-danger-50 text-gray-400 hover:text-danger-500 transition-colors"
                      title="Remove comparative analysis"
                    >
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <input
            type="file"
            id="comparative-analysis-upload"
            className="hidden"
            multiple
            accept=".pdf,.doc,.docx,.xls,.xlsx,.jpg,.jpeg,.png"
            onChange={handleComparativeAnalysisUpload}
          />

          <label
            htmlFor="comparative-analysis-upload"
            className={`block border-2 border-dashed rounded-xl p-6 text-center transition-all cursor-pointer group ${caRequired ? 'border-danger-200 hover:border-danger-300 hover:bg-danger-50/20' : 'border-gray-300 hover:border-gray-400 hover:bg-gray-50'}`}
          >
            <div className={`w-10 h-10 rounded-full flex items-center justify-center mx-auto mb-2 group-hover:bg-white group-hover:shadow-sm ${caRequired ? 'bg-danger-50' : 'bg-gray-100'}`}>
              <svg className={`w-5 h-5 transition-colors ${caRequired ? 'text-danger-400 group-hover:text-danger-500' : 'text-gray-400 group-hover:text-gray-500'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
              </svg>
            </div>
            <p className="text-sm text-gray-700 font-medium">Click to upload comparative analysis</p>
            <p className="text-xs text-gray-400 mt-1">PDF, Excel, Word, or Images up to 10MB</p>
          </label>

          {/* Uploaded Comparative Analysis List */}
          {comparativeAnalysisDocuments.length > 0 && (
            <div className="mt-4 space-y-4">
              <h4 className="text-sm font-medium text-gray-700">Uploaded Comparative Analysis:</h4>
              {comparativeAnalysisDocuments.map((doc, index) => (
                <div key={index} className="p-4 bg-gray-50 rounded-xl border border-gray-200 space-y-4">
                  <div className="flex items-start gap-3">
                    <div className="flex-shrink-0 mt-1">
                      <svg className="w-8 h-8 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2" />
                      </svg>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900 truncate">{doc.file.name}</p>
                      <p className="text-xs text-gray-500">{(doc.file.size / 1024).toFixed(1)} KB</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleRemoveComparativeAnalysis(index)}
                      className="flex-shrink-0 p-1.5 rounded-lg hover:bg-danger-50 text-gray-400 hover:text-danger-500 transition-colors"
                      title="Remove comparative analysis"
                    >
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Description</label>
                    <input
                      type="text"
                      className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 bg-white text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-all"
                      placeholder="e.g., Comparison of the 3 supplier quotations"
                      value={doc.description}
                      onChange={(e) => setComparativeAnalysisDocuments(prev => prev.map((d, i) => i === index ? { ...d, description: e.target.value } : d))}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
          );
        })()}

        {/* Supporting Documents Section - Optional */}
        <Card>
          <h3 className="font-semibold text-text-primary mb-3 flex items-center gap-2 text-lg">
            <svg className="w-5 h-5 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
            </svg>
            Supporting Documents
            <span className="ml-2 px-2 py-0.5 text-xs font-medium bg-gray-100 text-gray-600 rounded-full">Optional</span>
            {(existingSupportingDocs.length + supportingDocuments.length) > 0 && (
              <span className="ml-auto text-sm font-normal text-gray-500">({existingSupportingDocs.length + supportingDocuments.length} uploaded)</span>
            )}
          </h3>
          <p className="text-sm text-gray-600 mb-4">
            Upload any additional supporting documents such as specifications, technical drawings, or other relevant materials.
          </p>

          {/* Existing Supporting Documents (in edit mode) */}
          {isEditMode && existingSupportingDocs.length > 0 && (
            <div className="mb-4 space-y-3">
              <h4 className="text-sm font-medium text-gray-700">Existing Supporting Documents:</h4>
              {existingSupportingDocs.map((doc: any, index: number) => (
                <div key={index} className="p-4 rounded-xl border transition-all bg-[#F3EADC] border-[#C9B896]">
                  <div className="flex items-start gap-3">
                    <div className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 bg-[#F3EADC]">
                      <svg className="w-5 h-5 text-[#9A7545]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                      </svg>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-gray-900 text-sm">{doc.name}</p>
                      {doc.description && (
                        <p className="text-xs text-gray-500 mt-1">{doc.description}</p>
                      )}
                      {doc.size && (
                        <p className="text-xs text-gray-400 mt-0.5">{(doc.size / 1024).toFixed(1)} KB</p>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => handleRemoveExistingSupportingDoc(index)}
                      className="flex-shrink-0 p-1.5 rounded-lg hover:bg-danger-50 text-gray-400 hover:text-danger-500 transition-colors"
                      title="Remove supporting document"
                    >
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <input
            type="file"
            id="supporting-doc-upload"
            className="hidden"
            multiple
            accept=".pdf,.doc,.docx,.xls,.xlsx,.jpg,.jpeg,.png"
            onChange={handleSupportingDocUpload}
          />

          <label
            htmlFor="supporting-doc-upload"
            className="block border-2 border-dashed rounded-xl p-6 text-center transition-all cursor-pointer group border-gray-200 hover:border-primary-300 hover:bg-primary-50/20"
          >
            <div className="w-10 h-10 bg-gray-50 rounded-full flex items-center justify-center mx-auto mb-2 group-hover:bg-white group-hover:shadow-sm">
              <svg className="w-5 h-5 text-gray-400 group-hover:text-primary-500 transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
              </svg>
            </div>
            <p className="text-sm text-gray-700 font-medium">Click to upload supporting documents</p>
            <p className="text-xs text-gray-400 mt-1">PDF, Excel, Word, or Images up to 10MB</p>
          </label>

          {/* Uploaded Supporting Documents List */}
          {supportingDocuments.length > 0 && (
            <div className="mt-4 space-y-4">
              <h4 className="text-sm font-medium text-gray-700">Uploaded Supporting Documents:</h4>
              {supportingDocuments.map((doc, index) => (
                <div key={index} className="p-4 bg-gray-50 rounded-xl border border-gray-200 space-y-3">
                  <div className="flex items-start gap-3">
                    <div className="flex-shrink-0 mt-1">
                      <svg className="w-8 h-8 text-primary-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                      </svg>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900 truncate">{doc.file.name}</p>
                      <p className="text-xs text-gray-500">{(doc.file.size / 1024).toFixed(1)} KB</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleRemoveSupportingDoc(index)}
                      className="flex-shrink-0 p-1.5 rounded-lg hover:bg-danger-50 text-gray-400 hover:text-danger-500 transition-colors"
                      title="Remove document"
                    >
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">
                      Document Description
                    </label>
                    <input
                      type="text"
                      className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 bg-white text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-all"
                      placeholder="e.g., Technical specifications, drawings, etc."
                      value={doc.description}
                      onChange={(e) => handleUpdateSupportingDocMetadata(index, 'description', e.target.value)}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* Financials — placed just before Watchers so the Project Cost can be
            auto-totalled (and locked) from the selected suppliers above. */}
        <Card>
          <h3 className="font-semibold text-text-primary mb-4 flex items-center gap-2 text-lg">
            <svg className="w-5 h-5 text-success-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            Financial Analysis
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div data-field="amount">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Project Cost <span className="text-red-500">*</span>
              </label>
              <div className="relative">
                <span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-500">{formData.currency === 'ZIG' ? 'ZiG' : '$'}</span>
                <input
                  type="text"
                  readOnly={allowMultipleSuppliers}
                  tabIndex={allowMultipleSuppliers ? -1 : undefined}
                  className={`w-full pl-8 pr-4 py-2 min-h-[44px] rounded-xl border focus:outline-none focus:ring-2 focus:border-transparent transition-all ${allowMultipleSuppliers ? 'bg-gray-50 cursor-not-allowed text-gray-900' : 'bg-white text-gray-900 placeholder-gray-400'} ${fieldErrors.amount ? 'border-red-500 focus:ring-red-500' : 'border-gray-300 focus:ring-primary-500'}`}
                  placeholder="0.00"
                  value={formData.amount}
                  onChange={(e) => { if (allowMultipleSuppliers) return; setFormData({ ...formData, amount: formatCurrency(e.target.value) }); clearFieldError('amount'); }}
                  required
                />
              </div>
              {allowMultipleSuppliers && (
                <p className="mt-1 text-xs text-gray-500">Auto-calculated from the selected supplier quotations.</p>
              )}
              {fieldErrors.amount && <p className="mt-1 text-sm text-red-500">{fieldErrors.amount}</p>}
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Currency
              </label>
              <select
                className="w-full px-4 py-2 min-h-[44px] rounded-xl border border-gray-300 bg-white text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-all"
                value={formData.currency || 'USD'}
                onChange={(e) => setFormData({ ...formData, currency: e.target.value })}
              >
                <option value="USD">USD</option>
                <option value="ZIG">ZIG</option>
                <option value="ZAR">ZAR</option>
              </select>
            </div>
            {/* Budgeted CAPEX: capture the approved budget line, what's already
                been spent against it, and the balance remaining once this
                project is drawn down. Only shown when Budget Type = Budgeted. */}
            {isBudgetedCapex && (
              <div className="md:col-span-2 rounded-xl border border-primary-100 bg-primary-50/40 p-4">
                <p className="text-sm font-medium text-primary-800 mb-3">Budget Utilisation</p>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div data-field="budgetAmount">
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Budget Amount <span className="text-red-500">*</span>
                    </label>
                    <div className="relative">
                      <span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-500">{formData.currency === 'ZIG' ? 'ZiG' : '$'}</span>
                      <input
                        type="text"
                        className={`w-full pl-8 pr-4 py-2 min-h-[44px] rounded-xl border bg-white text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:border-transparent transition-all ${fieldErrors.budgetAmount ? 'border-red-500 focus:ring-red-500' : 'border-gray-300 focus:ring-primary-500'}`}
                        placeholder="0.00"
                        value={formData.budgetAmount}
                        onChange={(e) => { setFormData({ ...formData, budgetAmount: formatCurrency(e.target.value) }); clearFieldError('budgetAmount'); }}
                      />
                    </div>
                    {fieldErrors.budgetAmount && <p className="mt-1 text-sm text-red-500">{fieldErrors.budgetAmount}</p>}
                  </div>
                  <div data-field="amountSpent">
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Amount Spent <span className="text-red-500">*</span>
                    </label>
                    <div className="relative">
                      <span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-500">{formData.currency === 'ZIG' ? 'ZiG' : '$'}</span>
                      <input
                        type="text"
                        className={`w-full pl-8 pr-4 py-2 min-h-[44px] rounded-xl border bg-white text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:border-transparent transition-all ${fieldErrors.amountSpent ? 'border-red-500 focus:ring-red-500' : 'border-gray-300 focus:ring-primary-500'}`}
                        placeholder="0.00"
                        value={formData.amountSpent}
                        onChange={(e) => { setFormData({ ...formData, amountSpent: formatCurrency(e.target.value) }); clearFieldError('amountSpent'); }}
                      />
                    </div>
                    {fieldErrors.amountSpent && <p className="mt-1 text-sm text-red-500">{fieldErrors.amountSpent}</p>}
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Balance After Project
                    </label>
                    <div className="relative">
                      <span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-500">{formData.currency === 'ZIG' ? 'ZiG' : '$'}</span>
                      <input
                        type="text"
                        readOnly
                        className={`w-full pl-8 pr-4 py-2 min-h-[44px] rounded-xl border bg-gray-50 cursor-not-allowed focus:outline-none transition-all ${budgetBalanceAfterProject < 0 ? 'border-red-300 text-red-600' : 'border-gray-300 text-gray-900'}`}
                        value={budgetBalanceDisplay}
                        tabIndex={-1}
                      />
                    </div>
                    <p className="text-xs text-gray-500 mt-1">Budget − Spent − Project Cost</p>
                  </div>
                </div>
                {budgetBalanceAfterProject < 0 && (
                  <p className="text-xs text-red-600 mt-2">This project exceeds the remaining budget.</p>
                )}
              </div>
            )}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Payback Period
              </label>
              <select
                className="w-full px-4 py-2 min-h-[44px] rounded-xl border border-gray-300 bg-white text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-all"
                value={formData.paybackPeriod}
                onChange={(e) => setFormData({ ...formData, paybackPeriod: e.target.value })}
              >
                <option value="">Select period</option>
                <option value="<6m">Less than 6 months</option>
                <option value="6-12m">6-12 months</option>
                <option value="1-2y">1-2 years</option>
                <option value="2-3y">2-3 years</option>
                <option value=">3y">More than 3 years</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                NPV (Net Present Value)
              </label>
              <Input
                placeholder="e.g. 50000"
                value={formData.npv}
                onChange={(e) => setFormData({ ...formData, npv: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                IRR (Internal Rate of Return)
              </label>
              <Input
                placeholder="e.g. 15%"
                value={formData.irr}
                onChange={(e) => setFormData({ ...formData, irr: e.target.value })}
              />
            </div>
            <div data-field="fundingSource">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Project Funded By <span className="text-red-500">*</span>
              </label>
              <select
                className={`w-full px-4 py-2 min-h-[44px] rounded-xl border bg-white text-gray-900 focus:outline-none focus:ring-2 focus:border-transparent transition-all ${fieldErrors.fundingSource ? 'border-red-500 focus:ring-red-500' : 'border-gray-300 focus:ring-primary-500'}`}
                value={formData.fundingSource}
                onChange={(e) => { setFormData({ ...formData, fundingSource: e.target.value }); clearFieldError('fundingSource'); }}
                required
              >
                <option value="">Select funding source…</option>
                <option value="Internal Resources">Internal Resources</option>
                <option value="Corporate Funding">Corporate Funding</option>
                <option value="Bank Loan">Bank Loan</option>
              </select>
              {fieldErrors.fundingSource && <p className="mt-1 text-sm text-red-500">{fieldErrors.fundingSource}</p>}
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Evaluation
              </label>
              <Input
                placeholder="e.g. for cost reduction"
                value={formData.evaluation}
                onChange={(e) => setFormData({ ...formData, evaluation: e.target.value })}
              />
            </div>
          </div>
        </Card>

        {/* Select Watchers Section */}
        <Card>
          <h3 className="font-semibold text-text-primary mb-4 flex items-center gap-2 text-lg">
            <svg className="w-5 h-5 text-info-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
            </svg>
            Select Watchers
          </h3>
          <p className="text-sm text-text-secondary mb-4">
            Choose users who will be notified about this request. They cannot approve or reject.
          </p>

          {/* Search and Add Watchers */}
          <div className="mb-6 relative">
            <label className="block text-sm font-medium text-gray-700 mb-2">Search Users</label>
            <div className="relative">
              <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                type="text"
                className="w-full pl-10 pr-4 py-2 min-h-[44px] rounded-xl border border-gray-300 bg-white text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-all"
                placeholder="Search by name or email..."
                value={watcherSearch}
                onChange={(e) => {
                  setWatcherSearch(e.target.value);
                  setShowWatcherDropdown(true);
                }}
                onFocus={() => setShowWatcherDropdown(true)}
              />
            </div>

            {/* Dropdown Results */}
            {showWatcherDropdown && watcherSearch && (
              <div className="absolute z-20 w-full mt-1 bg-white border border-gray-200 rounded-xl shadow-lg max-h-60 overflow-y-auto">
                {loadingUsers ? (
                  <div className="flex items-center justify-center py-4">
                    <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-primary-500" />
                  </div>
                ) : filteredWatchers.length === 0 ? (
                  <div className="px-4 py-3 text-sm text-gray-500">
                    No users found
                  </div>
                ) : (
                  filteredWatchers.map((user) => (
                    <button
                      key={user.id}
                      type="button"
                      onClick={() => handleAddWatcher(user.id)}
                      className="w-full px-4 py-3 text-left hover:bg-primary-50 transition-colors flex items-center gap-3 border-b border-gray-100 last:border-b-0"
                    >
                      <div className="w-8 h-8 rounded-full bg-primary-100 flex items-center justify-center flex-shrink-0">
                        <span className="text-sm font-medium text-primary-600">
                          {user.display_name?.charAt(0)?.toUpperCase() || '?'}
                        </span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-900 truncate">{user.display_name}</p>
                        <p className="text-xs text-gray-500 truncate">{user.email}</p>
                      </div>
                      <svg className="w-5 h-5 text-primary-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                      </svg>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>

          {/* Click outside to close dropdown */}
          {showWatcherDropdown && (
            <div
              className="fixed inset-0 z-10"
              onClick={() => setShowWatcherDropdown(false)}
            />
          )}

          {/* Selected Watchers List */}
          <div>
            <h4 className="text-sm font-medium text-gray-700 mb-2">
              Selected Watchers {selectedWatchers.length > 0 && `(${selectedWatchers.length})`}
            </h4>
            {selectedWatchers.length === 0 ? (
              <div className="text-center py-8 text-gray-500 border border-dashed border-gray-200 rounded-xl">
                <svg className="w-8 h-8 mx-auto mb-2 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                </svg>
                <p className="text-sm">No watchers selected</p>
                <p className="text-xs text-gray-400 mt-1">Search and add users above</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {selectedWatchers.map((watcher) => {
                  const watcherUser = users.find(u => u.id === watcher.id);
                  if (!watcherUser) return null;
                  const canRemove = !isApproverEditing || (watcher.addedBy?.id === (user?.id || session?.user?.id));
                  return (
                    <div key={watcher.id} className={`relative flex items-center gap-3 group bg-white border p-3 rounded-xl shadow-sm ${watcher.addedBy?.isApprover ? 'border-primary-200 bg-primary-50/30' : 'border-gray-100'}`}>
                      <div className="w-10 h-10 rounded-full flex items-center justify-center bg-info-50 text-info-600 flex-shrink-0">
                        <span className="font-bold text-sm">
                          {watcherUser.display_name?.charAt(0)?.toUpperCase()}
                        </span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <h4 className="font-semibold text-text-primary text-sm truncate">{watcherUser.display_name}</h4>
                        <p className="text-xs text-text-secondary truncate">{watcherUser.email}</p>
                        {watcher.addedBy && (
                          <p className="text-xs text-primary-600 mt-0.5 flex items-center gap-1">
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                            </svg>
                            Added by {watcher.addedBy.name}
                            {watcher.addedBy.isApprover && (
                              <span className="ml-1 px-1.5 py-0.5 rounded text-xs bg-primary-100 text-primary-700">Approver</span>
                            )}
                          </p>
                        )}
                      </div>
                      {canRemove ? (
                        <button
                          type="button"
                          onClick={() => handleRemoveWatcher(watcher.id)}
                          className="p-1.5 rounded-lg hover:bg-danger-50 text-gray-400 hover:text-danger-500 transition-colors"
                          title="Remove"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      ) : (
                        <div className="p-1.5 text-gray-300" title="Cannot remove watchers added by others">
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                          </svg>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </Card>

        {/* Capex Workflow Section - Hidden for approvers editing */}
        {!isApproverEditing && (
        <Card data-field="approvers">
          <h3 className="font-semibold text-text-primary mb-4 flex items-center gap-2 text-lg">
            <svg className="w-5 h-5 text-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            Select Approvers
          </h3>
          <p className="text-sm text-text-secondary mb-4">
            Assign a user to each approval role below. Approvers are <span className="font-medium">optional</span> —
            leave a role blank and it will still appear on the form with an empty signature line.
          </p>
          {fieldErrors.approvers && (
            <div className="mb-4 p-3 rounded-xl bg-red-50 border border-red-200 text-sm text-red-600">
              {fieldErrors.approvers}
            </div>
          )}

          {/* Parallel vs Sequential Approval Toggle
          <div className="mb-6 p-4 bg-gray-50 rounded-xl border border-gray-200">
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={useParallelApprovals}
                onChange={(e) => setUseParallelApprovals(e.target.checked)}
                className="mt-1 w-5 h-5 text-primary-600 focus:ring-primary-500 border-gray-300 rounded"
              />
              <div>
                <span className="font-semibold text-gray-900 block">Use Parallel Approvals</span>
                <span className="text-sm text-gray-500 mt-1 block">
                  {useParallelApprovals 
                    ? 'All approvers will be notified immediately and can review the request simultaneously. Any approver can approve or reject at any time.'
                    : 'Approvals will be processed sequentially in the order shown below. Each approver must complete their review before the next approver is notified.'}
                </span>
              </div>
            </label>
          </div> */}

          {/* Role-based Approver Selection */}
          {!isEditMode && loadingApproverResolution && <ApproverSectionLoader rows={approvalRoles.length} />}
          <div className={`space-y-6 ${!isEditMode && loadingApproverResolution ? 'hidden' : ''}`}>
            {(() => {
              // Running index across sections drives the step number + connector.
              let globalIndex = -1;
              return approvalSections.map((section) => (
                <div key={section.title} className="space-y-4">
                  <div className="flex items-center gap-2 pb-1 border-b border-gray-200">
                    <h4 className="text-sm font-bold text-text-primary uppercase tracking-wide">{section.title}</h4>
                    <span className="text-xs font-normal text-gray-400 normal-case">(optional)</span>
                  </div>
                  {section.roles.map((role) => {
              globalIndex += 1;
              const index = globalIndex;
              const selectedUserId = selectedApprovers[role.key];
              const selectedUser = users.find(u => u.id === selectedUserId);
              const filteredUsersForRole = getFilteredUsersForRole(role.key);
              const isAutoResolved = autoResolvedRoles[role.key];
              const isLocked = isApproverRowLocked(role.key, isAutoResolved);

              return (
                <div key={role.key} className="relative">
                  <div className="flex items-start gap-3">
                    {/* Step Number */}
                    <div className="w-8 h-8 rounded-full flex items-center justify-center border-2 bg-primary-50 border-primary-200 text-primary-600 flex-shrink-0 mt-1">
                      <span className="font-bold text-xs">{index + 1}</span>
                    </div>

                    <div className="flex-1">
                      <label className="block text-sm font-semibold text-gray-700 mb-1">
                        {role.label}
                        <span className="font-normal text-gray-400 ml-2">({role.description})</span>
                      </label>

                      {selectedUser ? (
                        <div className={`flex items-center gap-3 p-3 rounded-xl ${isAutoResolved ? 'bg-green-50 border border-green-200' : 'bg-primary-50 border border-primary-200'}`}>
                          <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${isAutoResolved ? 'bg-green-100' : 'bg-primary-100'}`}>
                            <span className={`text-sm font-medium ${isAutoResolved ? 'text-green-600' : 'text-primary-600'}`}>
                              {selectedUser.display_name?.charAt(0)?.toUpperCase() || '?'}
                            </span>
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-gray-900 truncate">{selectedUser.display_name}</p>
                            <p className="text-xs text-gray-500 truncate">{selectedUser.email}</p>
                            {isAutoResolved && <p className="text-xs text-green-600 mt-0.5">Auto-assigned from HRIMS organogram{isLocked ? ' · locked' : ''}</p>}
                          </div>
                          {/* Senior fixed approvers (CEO, directors) are locked once
                              auto-resolved; departmental/managerial rows stay changeable. */}
                          {!isLocked && (
                          <button
                            type="button"
                            onClick={() => handleRemoveApprover(role.key)}
                            className="p-1.5 rounded-lg hover:bg-danger-50 text-gray-400 hover:text-danger-500 transition-colors"
                            title="Remove approver"
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" />
                            </svg>
                          </button>
                          )}
                        </div>
                      ) : (
                        <div className="relative">
                          <div className="relative">
                            <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                            </svg>
                            <input
                              type="text"
                              className="w-full pl-9 pr-4 py-2 min-h-[44px] rounded-xl border border-gray-300 bg-white text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-all text-sm"
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
                              ) : filteredUsersForRole.length === 0 ? (
                                <div className="px-4 py-3 text-sm text-gray-500">
                                  No users found
                                </div>
                              ) : (
                                filteredUsersForRole.slice(0, 10).map((user) => (
                                  <button
                                    key={user.id}
                                    type="button"
                                    onClick={() => handleSelectApprover(role.key, user.id)}
                                    className="w-full px-4 py-2 text-left hover:bg-primary-50 transition-colors flex items-center gap-3 border-b border-gray-100 last:border-b-0"
                                  >
                                    <div className="w-7 h-7 rounded-full bg-primary-100 flex items-center justify-center flex-shrink-0">
                                      <span className="text-xs font-medium text-primary-600">
                                        {user.display_name?.charAt(0)?.toUpperCase() || '?'}
                                      </span>
                                    </div>
                                    <div className="flex-1 min-w-0">
                                      <p className="text-sm font-medium text-gray-900 truncate">{user.display_name}</p>
                                      <p className="text-xs text-gray-500 truncate">{user.email}</p>
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
                    <div className="absolute left-4 top-10 bottom-0 w-0.5 bg-gray-200 -mb-4 h-4" style={{ transform: 'translateX(-50%)' }} />
                  )}
                </div>
              );
                  })}
                </div>
              ));
            })()}
          </div>

          {/* Click outside to close dropdown */}
          {showApproverDropdown && (
            <div
              className="fixed inset-0 z-10"
              onClick={() => setShowApproverDropdown(null)}
            />
          )}

          {/* Summary */}
          <div className="mt-6 p-4 bg-gray-50 rounded-xl border border-gray-200">
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-600">Approvers Selected</span>
              <span className="text-sm font-semibold text-primary-600">
                {approvalRoles.filter(r => selectedApprovers[r.key]).length} of {approvalRoles.length}
              </span>
            </div>
          </div>
        </Card>
        )}

        <div className="sticky bottom-0 p-4 bg-white/95 backdrop-blur-sm border-t border-gray-100 pb-safe z-20">
          <div className="flex gap-3 max-w-5xl mx-auto">
            <Button
              type="button"
              variant="secondary"
              className="flex-shrink-0"
              onClick={() => router.back()}
            >
              Cancel
            </Button>
            {/* Show Save as Draft only for new requests, not for edit mode */}
            {!isEditMode && (
              <Button
                type="button"
                variant="secondary"
                className="flex-1"
                onClick={(e) => handleSubmit(e, true)}
                isLoading={savingDraft}
                disabled={savingDraft || loading}
              >
                Save as Draft
              </Button>
            )}
            {/* Kept clickable even when the form is incomplete — handleSubmit
                validates and shows a toast + inline errors listing what's
                missing, rather than silently disabling the button. */}
            <Button
              type="submit"
              variant="primary"
              className="flex-1"
              isLoading={loading}
              disabled={loading || savingDraft}
            >
              {isEditMode ? 'Save Changes' : 'Submit for Approval'}
            </Button>
            {/* Show Publish button only for draft requests in edit mode */}
            {isEditMode && requestStatus === 'draft' && !isApproverEditing && (
              <Button
                type="button"
                variant="primary"
                className="flex-1 bg-emerald-600 hover:bg-emerald-700"
                onClick={() => setShowPublishModal(true)}
                disabled={
                  !formData.requester ||
                  !formData.projectName ||
                  !formData.amount ||
                  !formData.budgetType ||
                  !formData.justification ||
                  !formData.priority ||
                  Object.values(selectedApprovers).filter(Boolean).length < 1 ||
                  loading ||
                  publishing
                }
              >
                <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                Publish
              </Button>
            )}
          </div>
        </div>
      </form>

      {/* Publish Confirmation Modal */}
      {showPublishModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div 
            className="absolute inset-0 bg-black/50 backdrop-blur-sm"
            onClick={() => !publishing && setShowPublishModal(false)}
          />
          <div className="relative bg-white rounded-2xl shadow-2xl max-w-md w-full p-6 animate-in fade-in zoom-in duration-200">
            <div className="text-center">
              <div className="w-16 h-16 bg-emerald-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <svg className="w-8 h-8 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <h3 className="text-xl font-bold text-gray-900 mb-2">Submit for Approval?</h3>
              <p className="text-gray-600 mb-6">
                Are you sure you want to submit this CAPEX request for approval? Once submitted, the approval workflow will begin and approvers will be notified.
              </p>
              
              <div className="bg-gray-50 rounded-xl p-4 mb-6 text-left">
                <h4 className="text-sm font-semibold text-gray-700 mb-2">Request Summary</h4>
                <div className="space-y-1 text-sm">
                  <div className="flex justify-between">
                    <span className="text-gray-500">Project:</span>
                    <span className="font-medium text-gray-900">{formData.projectName}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">Amount:</span>
                    <span className="font-medium text-gray-900">{formData.currency === 'ZIG' ? 'ZiG' : '$'}{formData.amount}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">Approvers:</span>
                    <span className="font-medium text-gray-900">{Object.values(selectedApprovers).filter(Boolean).length} assigned</span>
                  </div>
                </div>
              </div>

              <div className="flex gap-3">
                <Button
                  type="button"
                  variant="secondary"
                  className="flex-1"
                  onClick={() => setShowPublishModal(false)}
                  disabled={publishing}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  variant="primary"
                  className="flex-1 bg-emerald-600 hover:bg-emerald-700"
                  onClick={handlePublish}
                  isLoading={publishing}
                  disabled={publishing}
                >
                  {publishing ? 'Publishing...' : 'Yes, Submit'}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      <RequestPreviewModal
        isOpen={showPreview}
        onClose={() => setShowPreview(false)}
        mode="preview"
        title="Capital Expenditure Form"
        sections={buildPreviewSections()}
        documentHeader={capexDocumentHeader}
      />
      <RequestPreviewModal
        isOpen={showConfirm}
        onClose={() => setShowConfirm(false)}
        mode="confirm"
        title="Capital Expenditure Form"
        sections={buildPreviewSections()}
        documentHeader={capexDocumentHeader}
        confirming={loading}
        onConfirm={async () => {
          setShowConfirm(false);
          await handleSubmit({ preventDefault: () => {} } as any, false, true);
        }}
      />
      <UnsavedChangesModal
        isOpen={unsavedPrompt.isOpen}
        savingDraft={savingDraft}
        canSaveDraft={!isApproverEditing && !isEditMode}
        onSaveDraft={() => unsavedPrompt.saveDraftAndContinue(async () => {
          await handleSubmit({ preventDefault: () => {} } as any, true, true);
        })}
        onDiscard={unsavedPrompt.discardAndContinue}
        onCancel={unsavedPrompt.cancel}
      />
    </AppLayout>
  );
}
