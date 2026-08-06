import { useRouter } from 'next/router';
import { useSession } from 'next-auth/react';
import { formatDateTime } from '@/lib/formatDate';
import { parseAmount } from '@/lib/money';
import { GetServerSideProps } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '../api/auth/[...nextauth]';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { resolveOnBehalfProfile } from '@/lib/onBehalf';
import { getUserRBACProfile, hasPermission } from '@/lib/rbac';
import { useCallback, useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { AppLayout } from '../../components/layout';
import { Card, Button, Input } from '../../components/ui';
import DynamicFormDetails from '../../components/DynamicFormDetails';
import CashReceiptConfirmation from '../../components/requests/CashReceiptConfirmation';
import { useToast } from '../../components/ui/ToastProvider';
import ConfirmDialog from '../../components/ui/ConfirmDialog';
import SignatureSelector, { type SignatureSelection } from '../../components/approvals/SignatureSelector';
import ApprovedRequestPreview, { ApprovedRequestPreviewInline, printApprovedRequest } from '../../components/requests/ApprovedRequestPreview';
import { getErrorMessage } from '@/lib/getErrorMessage';
import { isNetworkError } from '@/lib/networkError';
import Link from 'next/link';
import { AnimatePresence, motion } from 'framer-motion';
import criticalAnimation from '../../lotties/red critical.json';
import urgentAnimation from '../../lotties/orange warning exclamation.json';

const Lottie = dynamic(() => import('lottie-react'), { ssr: false });

const CRITICAL_ANIMATION_DURATION = 1.4;
const HIGH_ANIMATION_DURATION = 4.17;

const pulseKeyframes = `
@keyframes pulse-red-header {
  0%, 100% {
    box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.4), 0 4px 20px -2px rgba(239, 68, 68, 0.3);
    border-color: rgb(252, 165, 165);
  }
  50% {
    box-shadow: 0 0 0 6px rgba(239, 68, 68, 0), 0 8px 30px -2px rgba(239, 68, 68, 0.4);
    border-color: rgb(239, 68, 68);
  }
}

@keyframes pulse-orange-header {
  0%, 100% {
    box-shadow: 0 0 0 0 rgba(249, 115, 22, 0.4), 0 4px 20px -2px rgba(249, 115, 22, 0.3);
    border-color: rgb(253, 186, 116);
  }
  50% {
    box-shadow: 0 0 0 6px rgba(249, 115, 22, 0), 0 8px 30px -2px rgba(249, 115, 22, 0.4);
    border-color: rgb(249, 115, 22);
  }
}
`;

// Extended Request Interface for Detail View
interface RequestDetail {
    id: string;
    title: string;
    description: string;
    status: 'pending' | 'approved' | 'rejected' | 'in_review' | 'withdrawn' | 'draft' | 'cancelled';
    created_at: string;
    updated_at: string;
    current_step: number;
    total_steps: number;
    metadata?: Record<string, any>;
    creator_id?: string;
    creator: {
        id: string;
        display_name: string;
        email: string;
        profile_picture_url?: string;
        department_id?: string | null;
        business_unit_id?: string | null;
        job_title?: string | null;
        department?: { id: string; name: string } | null;
        business_unit?: { id: string; name: string } | null;
    };
    current_approver?: {
        id: string;
        display_name: string;
        email: string;
    } | null;
    request_steps: {
        id: string;
        step_index: number;
        step_type: string;
        approver_role: string;
        status: 'pending' | 'approved' | 'rejected' | 'skipped' | 'waiting';
        due_at?: string;
        created_at: string;
        activated_at?: string | null;
        first_viewed_at?: string | null;
        last_viewed_at?: string | null;
        is_redirected?: boolean;
        original_approver_id?: string | null;
        redirect_reason?: string | null;
        delegation_id?: string | null;
        approver?: {
            id: string;
            display_name: string;
            email: string;
            job_title?: string | null;
        } | null;
        original_approver?: {
            id: string;
            display_name: string;
            job_title?: string | null;
        } | null;
        approvals?: {
            id: string;
            decision: string;
            comment?: string;
            signed_at?: string;
            approver: {
                id: string;
                display_name: string;
                email: string;
            };
        }[];
    }[];
    documents?: {
        id: string;
        filename: string;
        storage_path: string;
        file_size?: number;
        mime_type?: string;
        created_at: string;
    }[];
}

const statusConfig: Record<string, { label: string; bg: string; text: string; icon: string }> = {
    pending: { label: 'Pending', bg: 'bg-amber-100/50', text: 'text-amber-700', icon: 'clock' },
    in_review: { label: 'In Review', bg: 'bg-[#F3EADC]/50', text: 'text-[#5E4426]', icon: 'refresh' },
    approved: { label: 'Approved', bg: 'bg-emerald-100/50', text: 'text-emerald-700', icon: 'check-circle' },
    rejected: { label: 'Rejected', bg: 'bg-rose-100/50', text: 'text-rose-700', icon: 'x-circle' },
    withdrawn: { label: 'Withdrawn', bg: 'bg-gray-100/50', text: 'text-gray-500', icon: 'minus-circle' },
    cancelled: { label: 'Cancelled', bg: 'bg-gray-100/50', text: 'text-gray-500', icon: 'minus-circle' },
    draft: { label: 'Draft', bg: 'bg-slate-100/50', text: 'text-slate-500', icon: 'document' },
};

// Friendly labels for metadata fields
const fieldLabels: Record<string, string> = {
    irr: 'Internal Rate of Return (IRR)',
    npv: 'Net Present Value (NPV)',
    unit: 'Business Unit',
    amount: 'Amount',
    endDate: 'End Date',
    category: 'Category',
    currency: 'Currency',
    requester: 'Requester',
    startDate: 'Start Date',
    budgetType: 'Budget Type',
    budgetAmount: 'Budget Amount',
    amountSpent: 'Amount Spent',
    budgetBalance: 'Balance After Project',
    department: 'Department',
    description: 'Description',
    projectName: 'Project Name',
    fundingSource: 'Funding Source',
    justification: 'Justification',
    paybackPeriod: 'Payback Period',
    type: 'Request Type',
    priority: 'Priority',
    evaluation: 'Financial Evaluation',
    // Price variation fields
    supplierName: 'Name of the Supplier',
    firstQuotation: 'First Quotation',
    secondQuotation: 'Second Quotation',
    firstQuotationNumber: 'First Quotation Number',
    secondQuotationNumber: 'Second Quotation Number',
    firstOrderNumber: 'First Order Number',
    secondOrderNumber: 'Second Order Number',
    dateOnQuotation: 'Date on Quotation',
    variance: 'Variance (1st vs 2nd)',
    reason: 'Reason for Price Variance',
    requestedBy: 'Requested By',
    parentTitle: 'CAPEX Reference',
    date: 'Date',
};

// Fields to exclude from display (internal/system fields)
const excludedFields = ['approvers', 'documents', 'type', 'category', 'capex', 'leave', 'travel', 'expense', 'parentRequestId', 'approverRoles', 'requiresCfo', 'priceVariations'];

// Format field value for display
function formatFieldValue(key: string, value: any): string {
    if (value === null || value === undefined || value === '') return '—';

    // Skip objects and arrays - they should be handled separately
    if (typeof value === 'object') return '—';

    // Handle currency formatting
    if ((key === 'amount' || key === 'npv' || key === 'budgetAmount' || key === 'amountSpent' || key === 'budgetBalance') && typeof value === 'string') {
        return value.includes(',') ? value : Number(value).toLocaleString();
    }

    // Handle payback period
    if (key === 'paybackPeriod') {
        const periods: Record<string, string> = {
            '<1y': 'Less than 1 year',
            '1-2y': '1-2 years',
            '2-3y': '2-3 years',
            '>3y': 'More than 3 years',
        };
        return periods[value] || value;
    }

    // Handle budget type
    if (key === 'budgetType') {
        return value.charAt(0).toUpperCase() + value.slice(1);
    }

    // Handle priority
    if (key === 'priority') {
        const priorities: Record<string, string> = {
            low: 'Low',
            normal: 'Normal',
            high: 'High',
            urgent: 'Urgent',
        };
        return priorities[value] || value;
    }

    return String(value);
}

// Get the form-specific data from metadata (handles nested structure like capex, leave, etc.)
function getFormData(metadata: Record<string, any> | undefined): Record<string, any> {
    if (!metadata) return {};

    // Check for nested form data (capex, leave, travel, expense, etc.)
    const formTypes = ['capex', 'leave', 'travel', 'expense', 'approval'];
    for (const formType of formTypes) {
        if (metadata[formType] && typeof metadata[formType] === 'object') {
            return metadata[formType];
        }
    }

    // If no nested structure, return metadata directly (excluding system fields)
    return metadata;
}

// Get friendly label for a field
function getFieldLabel(key: string): string {
    return fieldLabels[key] || key.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ').replace(/^./, str => str.toUpperCase());
}

// Format modification value for display (handles complex objects like budget)
function formatModificationValue(fieldName: string, value: any): string {
    if (value === null || value === undefined) return 'N/A';
    
    // If it's a string that looks like JSON, try to parse it
    let parsedValue = value;
    if (typeof value === 'string') {
        try {
            parsedValue = JSON.parse(value);
        } catch {
            // Not JSON, use as-is
            return value;
        }
    }
    
    // Handle budget object specially
    if (fieldName === 'budget' && typeof parsedValue === 'object') {
        const budgetLabels: Record<string, string> = {
            fuel: 'Fuel',
            aaRates: 'AA Rates',
            airBusTickets: 'Air/Bus Tickets',
            'b&b': 'Overnight Accommodation (B&B)',
            lunchDinner: 'Lunch/Dinner',
            conferencingCost: 'Conferencing',
            tollgates: 'Tollgates',
            other: 'Other',
        };

        
        const items: string[] = [];
        for (const [key, item] of Object.entries(parsedValue)) {
            const budgetItem = item as { quantity?: string; unitCost?: string; totalCost?: string };
            if (budgetItem.totalCost && parseFloat(budgetItem.totalCost) > 0) {
                const label = budgetLabels[key] || key;
                items.push(`${label}: $${budgetItem.totalCost}`);
            }
        }
        return items.length > 0 ? items.join(', ') : 'No items';
    }
    
    // Handle itinerary array
    if (fieldName === 'itinerary' && Array.isArray(parsedValue)) {
        const legs = parsedValue.filter((leg: any) => leg.from || leg.to);
        if (legs.length === 0) return 'No itinerary';
        return `${legs.length} leg${legs.length !== 1 ? 's' : ''}: ${legs.map((leg: any) => `${leg.from || '?'} → ${leg.to || '?'}`).join(', ')}`;
    }
    
    // Handle selectedBusinessUnits array
    if (fieldName === 'selectedBusinessUnits' && Array.isArray(parsedValue)) {
        return parsedValue.map((bu: any) => bu.name || 'Unknown').join(', ') || 'None';
    }
    
    // Handle other objects - show a summary
    if (typeof parsedValue === 'object' && !Array.isArray(parsedValue)) {
        const keys = Object.keys(parsedValue);
        if (keys.length === 0) return 'Empty';
        // Show first few meaningful values
        const summary: string[] = [];
        for (const key of keys.slice(0, 3)) {
            const val = parsedValue[key];
            if (val && typeof val !== 'object') {
                summary.push(`${getFieldLabel(key)}: ${val}`);
            }
        }
        if (summary.length > 0) return summary.join(', ');
        return `${keys.length} field${keys.length !== 1 ? 's' : ''}`;
    }
    
    // Handle arrays
    if (Array.isArray(parsedValue)) {
        return `${parsedValue.length} item${parsedValue.length !== 1 ? 's' : ''}`;
    }
    
    return String(value);
}

// Interface for metadata documents
interface MetadataDocument {
    name: string;
    size: number;
    type: string;
    path?: string;
}

// Interface for approver info
interface ApproverInfo {
    id: string;
    display_name: string;
    email: string;
    profile_picture_url?: string;
    job_title?: string | null;
    status: 'pending' | 'approved' | 'rejected';
    signed_at?: string;
    comment?: string;
    first_viewed_at?: string | null;
    last_viewed_at?: string | null;
    /** When the request landed on this approver's desk (step activated). */
    activated_at?: string | null;
    /** Step row creation time — fallback for "received" when activated_at is null. */
    step_created_at?: string | null;
    /** This approver's slot has been delegated to someone else. */
    delegated?: boolean;
    delegateName?: string | null;
    delegateJobTitle?: string | null;
    delegationReason?: string | null;
}

// Helper to get approver IDs from metadata (handles nested structures)
function getApproverIds(metadata: Record<string, any> | undefined): string[] {
    if (!metadata) return [];

    // Check direct approvers array
    if (Array.isArray(metadata.approvers)) {
        return metadata.approvers;
    }

    // Check nested form data (capex, leave, travel, expense, etc.)
    const formTypes = ['capex', 'leave', 'travel', 'expense', 'approval'];
    for (const formType of formTypes) {
        if (metadata[formType] && Array.isArray(metadata[formType].approvers)) {
            return metadata[formType].approvers;
        }
    }

    return [];
}

// Humanise a duration in ms as e.g. "3h 20m", "2d 4h", "< 1m".
function formatDuration(ms: number): string {
    if (!Number.isFinite(ms) || ms < 0) return '—';
    const mins = Math.floor(ms / 60000);
    if (mins < 1) return '< 1m';
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) {
        const rem = mins % 60;
        return rem ? `${hours}h ${rem}m` : `${hours}h`;
    }
    const days = Math.floor(hours / 24);
    const remH = hours % 24;
    return remH ? `${days}d ${remH}h` : `${days}d`;
}

// ApprovalTimeline component to show approvers and their status
function ApprovalTimeline({ request, isEditing, onApproversChange }: {
    request: RequestDetail;
    isEditing?: boolean;
    onApproversChange?: (approverIds: string[]) => void;
}) {
    const { data: session } = useSession();
    const currentUserId = session?.user?.id;
    
    // Check if current user is the requestor (creator of the request)
    const isRequestor = request.creator?.id === currentUserId;
    
    const [approvers, setApprovers] = useState<ApproverInfo[]>([]);
    const [loadingApprovers, setLoadingApprovers] = useState(true);
    const [allUsers, setAllUsers] = useState<Array<{ id: string; display_name: string; email: string; profile_picture_url?: string }>>([]);
    const [approverSearch, setApproverSearch] = useState('');
    const [showApproverDropdown, setShowApproverDropdown] = useState(false);

    // Fetch all users for editing mode
    useEffect(() => {
        if (isEditing) {
            fetch('/api/users')
                .then(res => res.json())
                .then(data => setAllUsers(data.users || []))
                .catch(err => console.error('Error fetching users:', err));
        }
    }, [isEditing]);

    useEffect(() => {
        async function fetchApprovers() {
            // Get approver IDs from metadata (handles nested structures)
            const approverIds: string[] = getApproverIds(request.metadata);

            if (approverIds.length === 0) {
                setLoadingApprovers(false);
                return;
            }

            try {
                // Fetch approver details
                const response = await fetch(`/api/users/by-ids?ids=${approverIds.join(',')}`);
                if (response.ok) {
                    const data = await response.json();
                    const users = data.users || [];

                    // Map approvers with their status from request_steps.
                    // A delegated step's approver is now the delegate, so also
                    // match on original_approver_id to keep the original slot.
                    const approverInfos: ApproverInfo[] = approverIds.map((id, index) => {
                        const user = users.find((u: any) => u.id === id);
                        const step = request.request_steps?.find(s => s.approver?.id === id)
                            || request.request_steps?.find(s => s.original_approver_id === id);
                        const approval = step?.approvals?.[0];
                        const delegated = !!(step?.is_redirected && step?.original_approver_id === id);

                        return {
                            id,
                            display_name: user?.display_name || `Approver ${index + 1}`,
                            email: user?.email || '',
                            profile_picture_url: user?.profile_picture_url,
                            job_title: user?.job_title || step?.original_approver?.job_title || null,
                            status: step?.status === 'approved' ? 'approved' :
                                step?.status === 'rejected' ? 'rejected' : 'pending',
                            signed_at: approval?.signed_at,
                            comment: approval?.comment,
                            first_viewed_at: step?.first_viewed_at || null,
                            last_viewed_at: step?.last_viewed_at || null,
                            activated_at: step?.activated_at || null,
                            step_created_at: step?.created_at || null,
                            delegated,
                            delegateName: delegated ? (step?.approver?.display_name || null) : null,
                            delegateJobTitle: delegated ? (step?.approver?.job_title || null) : null,
                            delegationReason: delegated ? (step?.redirect_reason || null) : null,
                        };
                    });

                    setApprovers(approverInfos);
                } else {
                    // Fallback: use request_steps data if available
                    const approverInfos: ApproverInfo[] = approverIds.map((id, index) => {
                        const step = request.request_steps?.[index];
                        const approval = step?.approvals?.[0];

                        return {
                            id,
                            display_name: step?.approver?.display_name || `Approver ${index + 1}`,
                            email: step?.approver?.email || '',
                            job_title: step?.approver?.job_title || null,
                            status: step?.status === 'approved' ? 'approved' :
                                step?.status === 'rejected' ? 'rejected' : 'pending',
                            signed_at: approval?.signed_at,
                            comment: approval?.comment,
                            first_viewed_at: step?.first_viewed_at || null,
                            last_viewed_at: step?.last_viewed_at || null,
                            activated_at: step?.activated_at || null,
                            step_created_at: step?.created_at || null,
                        };
                    });
                    setApprovers(approverInfos);
                }
            } catch (error) {
                console.error('Error fetching approvers:', error);
                // Fallback to request_steps
                const approverInfos: ApproverInfo[] = request.request_steps?.map((step, index) => ({
                    id: step.approver?.id || `step-${index}`,
                    display_name: step.approver?.display_name || step.approver_role || `Approver ${index + 1}`,
                    email: step.approver?.email || '',
                    status: step.status === 'approved' ? 'approved' :
                        step.status === 'rejected' ? 'rejected' : 'pending',
                    signed_at: step.approvals?.[0]?.signed_at,
                    comment: step.approvals?.[0]?.comment,
                    first_viewed_at: step.first_viewed_at || null,
                    last_viewed_at: step.last_viewed_at || null,
                    activated_at: (step as any).activated_at || null,
                    step_created_at: (step as any).created_at || null,
                })) || [];
                setApprovers(approverInfos);
            } finally {
                setLoadingApprovers(false);
            }
        }

        fetchApprovers();
    }, [request]);

    const handleAddApprover = (userId: string) => {
        const user = allUsers.find(u => u.id === userId);
        if (user && !approvers.find(a => a.id === userId)) {
            const newApprover: ApproverInfo = {
                id: userId,
                display_name: user.display_name,
                email: user.email,
                status: 'pending',
            };
            const newApprovers = [...approvers, newApprover];
            setApprovers(newApprovers);
            onApproversChange?.(newApprovers.map(a => a.id));
        }
        setApproverSearch('');
        setShowApproverDropdown(false);
    };

    const handleRemoveApprover = (userId: string) => {
        const newApprovers = approvers.filter(a => a.id !== userId);
        setApprovers(newApprovers);
        onApproversChange?.(newApprovers.map(a => a.id));
    };

    const handleMoveApprover = (index: number, direction: 'up' | 'down') => {
        const newApprovers = [...approvers];
        const targetIndex = direction === 'up' ? index - 1 : index + 1;
        if (targetIndex >= 0 && targetIndex < newApprovers.length) {
            [newApprovers[index], newApprovers[targetIndex]] = [newApprovers[targetIndex], newApprovers[index]];
            setApprovers(newApprovers);
            onApproversChange?.(newApprovers.map(a => a.id));
        }
    };

    const filteredUsers = allUsers.filter(user =>
        !approvers.find(a => a.id === user.id) &&
        (user.display_name?.toLowerCase().includes(approverSearch.toLowerCase()) ||
            user.email?.toLowerCase().includes(approverSearch.toLowerCase()))
    );

    if (loadingApprovers) {
        return (
            <div className="flex items-center justify-center py-12">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-500"></div>
            </div>
        );
    }

    // Render edit mode UI for adding approvers
    const renderEditControls = () => {
        if (!isEditing) return null;

        return (
            <div className="mb-8 relative z-20">
                <div className="relative">
                    <span className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                        <svg className="h-5 w-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                        </svg>
                    </span>
                    <input
                        type="text"
                        className="w-full pl-10 pr-4 py-3 rounded-xl border border-gray-200 bg-white shadow-sm focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 transition-all"
                        placeholder="Search users to add as approvers..."
                        value={approverSearch}
                        onChange={(e) => {
                            setApproverSearch(e.target.value);
                            setShowApproverDropdown(true);
                        }}
                        onFocus={() => setShowApproverDropdown(true)}
                    />
                    {showApproverDropdown && approverSearch && filteredUsers.length > 0 && (
                        <div className="absolute w-full mt-2 bg-white border border-gray-100 rounded-xl shadow-xl max-h-60 overflow-y-auto overflow-hidden">
                            {filteredUsers.slice(0, 5).map(user => (
                                <button
                                    key={user.id}
                                    type="button"
                                    className="w-full px-4 py-3 text-left hover:bg-gray-50 flex items-center gap-3 border-b border-gray-50 last:border-0 transition-colors"
                                    onClick={() => handleAddApprover(user.id)}
                                >
                                    <img
                                        src={user.profile_picture_url || `https://ui-avatars.com/api/?name=${encodeURIComponent(user.display_name)}&background=random&size=32`}
                                        alt={user.display_name}
                                        className="w-8 h-8 rounded-full object-cover"
                                    />
                                    <div>
                                        <div className="font-medium text-gray-900">{user.display_name}</div>
                                        <div className="text-xs text-gray-500">{user.email}</div>
                                    </div>
                                    <div className="ml-auto text-primary-600 text-sm font-medium">Add +</div>
                                </button>
                            ))}
                        </div>
                    )}
                </div>
            </div>
        );
    };

    if (approvers.length === 0) {
        return (
            <div className="bg-white rounded-2xl p-8 border border-gray-100 text-center shadow-sm">
                {renderEditControls()}
                <div className="text-center py-8">
                    <div className="w-16 h-16 bg-gray-50 rounded-full flex items-center justify-center mx-auto mb-4">
                        <svg className="w-8 h-8 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                        </svg>
                    </div>
                    <p className="text-gray-500">
                        {isEditing ? 'Search and add approvers above' : 'No approvers assigned to this request.'}
                    </p>
                </div>
            </div>
        );
    }

    return (
        <div className="max-w-3xl">
            {renderEditControls()}

            <div className="relative pl-6 sm:pl-10 space-y-8 pb-8">
                {/* Vertical Line */}
                <div className="absolute left-[1.15rem] sm:left-[2.15rem] top-4 bottom-4 w-0.5 bg-gray-100" />

                {approvers.map((approver, index) => {
                    const isApproved = approver.status === 'approved';
                    const isRejected = approver.status === 'rejected';
                    const isPending = approver.status === 'pending';

                    // Determine if this is the active pending step (first pending one)
                    const prevStepsApproved = index === 0 || approvers.slice(0, index).every(a => a.status === 'approved');
                    const isActive = isPending && prevStepsApproved;

                    return (
                        <motion.div
                            initial={{ opacity: 0, y: 20 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: index * 0.1 }}
                            key={approver.id}
                            className="relative"
                        >
                            {/* Connector Line Cover (for top/bottom spacing) */}
                            {/* Node */}
                            <div className={`
                                absolute -left-[1.65rem] top-0 w-10 h-10 rounded-full border-4 flex items-center justify-center z-10 transition-all duration-300
                                ${isApproved
                                    ? 'bg-emerald-500 border-white shadow-lg shadow-emerald-200'
                                    : isRejected
                                        ? 'bg-rose-500 border-white shadow-lg shadow-rose-200'
                                        : isActive
                                            ? 'bg-white border-primary-500 text-primary-600 shadow-lg shadow-primary-100 scale-110'
                                            : 'bg-white border-gray-200 text-gray-400'
                                }
                            `}>
                                {isApproved ? (
                                    <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                                    </svg>
                                ) : isRejected ? (
                                    <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
                                    </svg>
                                ) : (
                                    <span className="font-bold text-sm">{index + 1}</span>
                                )}
                            </div>

                            {/* Content Card */}
                            <div className={`
                                ml-4 p-5 rounded-2xl border transition-all duration-300 group
                                ${isActive && !isEditing
                                    ? 'bg-white border-primary-200 shadow-lg shadow-primary-50 ring-1 ring-primary-100'
                                    : 'bg-white border-gray-100 shadow-sm hover:shadow-md hover:border-gray-200'
                                }
                            `}>
                                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                                    <div className="flex items-center gap-4">
                                        <div className="relative">
                                            <img
                                                src={approver.profile_picture_url || `https://ui-avatars.com/api/?name=${encodeURIComponent(approver.display_name)}&background=random&size=48`}
                                                alt={approver.display_name}
                                                className="w-12 h-12 rounded-full object-cover border-2 border-white shadow-sm"
                                            />
                                            {isApproved && (
                                                <div className="absolute -bottom-1 -right-1 bg-emerald-500 rounded-full p-0.5 border-2 border-white">
                                                    <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 13l4 4L19 7" />
                                                    </svg>
                                                </div>
                                            )}
                                        </div>

                                        <div>
                                            <h4 className={`font-bold text-lg ${isActive && !isEditing ? 'text-primary-700' : 'text-gray-900'}`}>
                                                {approver.display_name}
                                            </h4>
                                            {approver.job_title && (
                                                <p className="text-xs font-medium text-primary-700 mt-0.5">{approver.job_title}</p>
                                            )}
                                            {approver.delegated && (
                                                <p
                                                    className="mt-1 inline-flex items-center gap-1 text-xs font-semibold text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5"
                                                    title={approver.delegationReason ? `Reason: ${approver.delegationReason}` : undefined}
                                                >
                                                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                                                    </svg>
                                                    Delegated to {approver.delegateName || 'a delegate'}
                                                    {approver.delegateJobTitle ? ` (${approver.delegateJobTitle})` : ''}
                                                </p>
                                            )}
                                            <p className="text-sm text-gray-500">{approver.email}</p>
                                            <div className="mt-1 flex items-center gap-2 flex-wrap">
                                                {approver.first_viewed_at ? (
                                                    <span
                                                        className="inline-flex items-center gap-1 text-xs text-emerald-700 bg-emerald-50 border border-emerald-100 rounded-full px-2 py-0.5"
                                                        title={`First opened ${formatDateTime(approver.first_viewed_at)}\nLast viewed ${approver.last_viewed_at ? formatDateTime(approver.last_viewed_at) : '—'}`}
                                                    >
                                                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                                                        </svg>
                                                        Request opened at {formatDateTime(approver.first_viewed_at)}
                                                    </span>
                                                ) : isActive ? (
                                                    <span className="inline-flex items-center gap-1 text-xs text-gray-500 bg-gray-50 border border-gray-200 rounded-full px-2 py-0.5">
                                                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                                                        </svg>
                                                        Not reviewed yet
                                                    </span>
                                                ) : null}
                                            </div>
                                            {/* Received / Reviewed / Sitting — approval turnaround detail.
                                                Only meaningful once the step has acted (approved/rejected) or
                                                is the CURRENT approver; future waiting steps show nothing. */}
                                            {(() => {
                                                const hasActed = isApproved || isRejected || !!approver.signed_at;
                                                if (!hasActed && !isActive) return null;
                                                const received = approver.activated_at || approver.step_created_at || null;
                                                if (!received) return null;
                                                const receivedMs = new Date(received).getTime();
                                                const endMs = approver.signed_at ? new Date(approver.signed_at).getTime() : Date.now();
                                                const sittingMs = endMs - receivedMs;
                                                // Live "on desk" counter only for the current approver.
                                                const stillWaiting = !approver.signed_at && isActive;
                                                const overdue = stillWaiting && sittingMs > 24 * 60 * 60 * 1000;
                                                return (
                                                    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-gray-500">
                                                        <span>Received {formatDateTime(received)}</span>
                                                        {approver.signed_at ? (
                                                            <>
                                                                <span aria-hidden>·</span>
                                                                <span>Reviewed {formatDateTime(approver.signed_at)}</span>
                                                                <span aria-hidden>·</span>
                                                                <span>Turnaround {formatDuration(sittingMs)}</span>
                                                            </>
                                                        ) : stillWaiting ? (
                                                            <>
                                                                <span aria-hidden>·</span>
                                                                <span className={overdue ? 'text-rose-600 font-medium' : ''}>
                                                                    On desk {formatDuration(sittingMs)}{overdue ? ' — overdue' : ''}
                                                                </span>
                                                            </>
                                                        ) : null}
                                                    </div>
                                                );
                                            })()}
                                        </div>
                                    </div>

                                    {/* Actions / Status Badge */}
                                    <div className="flex items-center gap-2 self-start sm:self-center ml-16 sm:ml-0">
                                        {isEditing ? (
                                            <div className="flex items-center gap-1">
                                                <button
                                                    type="button"
                                                    onClick={() => handleMoveApprover(index, 'up')}
                                                    disabled={index === 0}
                                                    className="p-2 rounded-lg hover:bg-gray-100 text-gray-500 disabled:opacity-30 transition-colors"
                                                >
                                                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 15l7-7 7 7" />
                                                    </svg>
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => handleMoveApprover(index, 'down')}
                                                    disabled={index === approvers.length - 1}
                                                    className="p-2 rounded-lg hover:bg-gray-100 text-gray-500 disabled:opacity-30 transition-colors"
                                                >
                                                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 9l-7 7-7-7" />
                                                    </svg>
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => handleRemoveApprover(approver.id)}
                                                    className="p-2 rounded-lg hover:bg-rose-50 text-rose-500 transition-colors"
                                                >
                                                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" />
                                                    </svg>
                                                </button>
                                            </div>
                                        ) : (
                                            <div className="flex flex-col items-end gap-1">
                                                {isApproved ? (
                                                    <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-100">
                                                        Approved
                                                    </span>
                                                ) : isRejected ? (
                                                    <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-rose-50 text-rose-700 border border-rose-100">
                                                        Rejected
                                                    </span>
                                                ) : isActive ? (
                                                    <div className="flex flex-col items-end gap-2">
                                                        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-primary-50 text-primary-700 border border-primary-100 animate-pulse">
                                                            Awaiting Action
                                                        </span>
                                                    </div>
                                                ) : (
                                                    <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-gray-50 text-gray-500 border border-gray-100">
                                                        Pending
                                                    </span>
                                                )}

                                                {approver.signed_at && (
                                                    <span className="text-xs text-gray-400">
                                                        {new Date(approver.signed_at).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' })}
                                                    </span>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                </div>

                                {/* Comments */}
                                {!isEditing && approver.comment && (
                                    <motion.div
                                        initial={{ height: 0, opacity: 0 }}
                                        animate={{ height: 'auto', opacity: 1 }}
                                        className="mt-4 pt-4 border-t border-gray-100"
                                    >
                                        <div className="bg-gray-50 rounded-lg p-3 text-sm text-gray-700 relative">
                                            <div className="absolute top-0 left-4 -mt-2 w-4 h-4 bg-gray-50 transform rotate-45 border-l border-t border-gray-100"></div>
                                            <p className="italic">&ldquo;{approver.comment}&rdquo;</p>
                                        </div>
                                    </motion.div>
                                )}
                            </div>
                        </motion.div>
                    );
                })}
            </div>

           
        </div>
    );
}

// Watcher data type (supports both old string[] format and new object format)
interface WatcherData {
    id: string;
    addedBy?: {
        id: string;
        name: string;
        isApprover: boolean;
    };
    addedAt?: string;
}

// WatchersCard component to display watchers for a request
function WatchersCard({ watcherData }: { watcherData?: (string | WatcherData)[] }) {
    const [watchers, setWatchers] = useState<Array<{ id: string; display_name: string; email: string; profile_picture_url?: string; addedBy?: WatcherData['addedBy']; addedAt?: string }>>([]);
    const [loading, setLoading] = useState(true);

    // Normalize watcher data to handle both old (string[]) and new (object[]) formats
    const normalizedWatchers: WatcherData[] = (Array.isArray(watcherData) ? watcherData : []).map(w => 
        typeof w === 'string' ? { id: w } : w
    );

    useEffect(() => {
        async function fetchWatchers() {
            if (normalizedWatchers.length === 0) {
                setLoading(false);
                return;
            }

            try {
                const watcherIds = normalizedWatchers.map(w => w.id);
                const response = await fetch(`/api/users/by-ids?ids=${watcherIds.join(',')}`);
                if (response.ok) {
                    const data = await response.json();
                    const users = data.users || [];
                    // Merge user data with watcher metadata
                    const watchersWithMetadata = normalizedWatchers.map(w => {
                        const user = users.find((u: any) => u.id === w.id);
                        return {
                            id: w.id,
                            display_name: user?.display_name || 'Unknown',
                            email: user?.email || '',
                            profile_picture_url: user?.profile_picture_url,
                            addedBy: w.addedBy,
                            addedAt: w.addedAt,
                        };
                    });
                    setWatchers(watchersWithMetadata);
                }
            } catch (error) {
                console.error('Error fetching watchers:', error);
            } finally {
                setLoading(false);
            }
        }

        fetchWatchers();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [JSON.stringify(normalizedWatchers)]);

    if (normalizedWatchers.length === 0) {
        return null;
    }

    if (loading) {
        return (
            <div className="animate-pulse flex space-x-2">
                <div className="h-8 w-8 bg-gray-200 rounded-full"></div>
                <div className="h-8 w-8 bg-gray-200 rounded-full"></div>
                <div className="h-8 w-8 bg-gray-200 rounded-full"></div>
            </div>
        );
    }

    return (
        <Card className="!p-5 border-gray-100/60 shadow-sm hover:shadow-md transition-all duration-300">
            <h3 className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-3 flex items-center gap-2">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                </svg>
                Watchers ({watchers.length})
            </h3>

            <div className="space-y-2">
                {watchers.map((watcher) => (
                    <div key={watcher.id} className={`flex items-center gap-3 p-2 rounded-lg ${watcher.addedBy?.isApprover ? 'bg-primary-50/50 border border-primary-100' : 'hover:bg-gray-50'}`}>
                        <img
                            src={watcher.profile_picture_url || `https://ui-avatars.com/api/?name=${encodeURIComponent(watcher.display_name)}&background=random&size=40`}
                            alt={watcher.display_name}
                            className="w-9 h-9 rounded-full border-2 border-white shadow-sm object-cover"
                        />
                        <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-gray-900 truncate">{watcher.display_name}</p>
                            {watcher.addedBy && (
                                <p className="text-xs text-primary-600 flex items-center gap-1">
                                    Added by {watcher.addedBy.name}
                                    {watcher.addedBy.isApprover && (
                                        <span className="px-1.5 py-0.5 rounded text-xs bg-primary-100 text-primary-700">Approver</span>
                                    )}
                                </p>
                            )}
                        </div>
                    </div>
                ))}
            </div>
        </Card>
    );
}

// Inline editor used when a requester edits a REJECTED request before
// resubmitting it. Renders the scalar form fields (skipping nested
// objects/arrays and internal fields) as editable inputs. Nested structures
// like budget tables aren't editable here — the requester adjusts the simple
// fields to address the rejection, and title/description in the page header.
function ResubmitFieldsEditor({
    metadata,
    onChange,
}: {
    metadata: Record<string, any> | undefined;
    onChange: (key: string, value: any) => void;
}) {
    const formData = getFormData(metadata);
    const entries = Object.entries(formData).filter(
        ([key, value]) =>
            !excludedFields.includes(key) &&
            (value === null || value === undefined || typeof value !== 'object')
    );

    if (entries.length === 0) {
        return (
            <p className="text-sm text-gray-500">
                This request has no inline-editable fields. You can still update the title and
                description above, then resubmit.
            </p>
        );
    }

    return (
        <div className="space-y-4">
            {entries.map(([key, value]) => {
                const str = value === null || value === undefined ? '' : String(value);
                const isLong = str.length > 60 || key === 'description' || key === 'justification' || key === 'notes';
                return (
                    <div key={key}>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                            {getFieldLabel(key)}
                        </label>
                        {isLong ? (
                            <textarea
                                value={str}
                                onChange={(e) => onChange(key, e.target.value)}
                                className="w-full px-4 py-2.5 rounded-xl border border-gray-300 bg-white text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent min-h-[90px]"
                            />
                        ) : (
                            <input
                                type="text"
                                value={str}
                                onChange={(e) => onChange(key, e.target.value)}
                                className="w-full px-4 py-2.5 rounded-xl border border-gray-300 bg-white text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                            />
                        )}
                    </div>
                );
            })}
        </div>
    );
}

// Timeline card listing every prior submission round that ended in rejection,
// reconstructed from metadata.resubmissionHistory. Together with the live
// ApprovalTimeline (current round) and the Modification History this gives a
// full chronological picture: original submission → rejection → resubmission.
function ResubmissionHistoryCard({ history }: { history?: any[] }) {
    if (!Array.isArray(history) || history.length === 0) return null;

    return (
        <Card className="!p-0 overflow-hidden border-rose-100 shadow-sm">
            <div className="bg-rose-50/50 px-6 py-4 border-b border-rose-100 flex items-center justify-between">
                <h3 className="font-semibold text-rose-800 flex items-center gap-2">
                    <svg className="w-5 h-5 text-rose-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 10h18M3 6h18M3 14h18M3 18h18" />
                    </svg>
                    Previous Submission Rounds
                </h3>
                <span className="text-sm text-rose-600 font-medium">
                    {history.length} round{history.length !== 1 ? 's' : ''}
                </span>
            </div>
            <div className="p-4 space-y-3">
                {history.map((round: any, index: number) => (
                    <div
                        key={index}
                        className="p-4 bg-white rounded-xl border border-gray-100"
                    >
                        <div className="flex items-center gap-2 flex-wrap mb-2">
                            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-rose-100 text-rose-700">
                                Round {round.version ?? index + 1} — Rejected
                            </span>
                            {round.referenceCode && (
                                <span className="font-mono text-xs font-semibold text-gray-600 bg-gray-100 px-2 py-0.5 rounded border border-gray-200 tracking-wider">
                                    {round.referenceCode}
                                </span>
                            )}
                        </div>
                        <p className="text-sm text-gray-700">
                            Rejected by{' '}
                            <span className="font-medium text-gray-900">
                                {round.rejectedByName || 'An approver'}
                            </span>
                            {round.rejectedByRole ? ` (${round.rejectedByRole})` : ''}
                            {round.rejectedAtStep ? ` at step ${round.rejectedAtStep}` : ''}
                            {round.stepLabel ? ` (${round.stepLabel})` : ''}
                            {round.rejectedAt ? ` on ${formatDateTime(round.rejectedAt)}` : ''}.
                        </p>
                        {round.comment && (
                            <div className="mt-2 bg-rose-50/60 rounded-lg p-3 text-sm text-gray-700 border border-rose-100">
                                <span className="text-xs font-semibold text-rose-700 uppercase tracking-wide">Reason</span>
                                <p className="italic mt-1">&ldquo;{round.comment}&rdquo;</p>
                            </div>
                        )}
                    </div>
                ))}
            </div>
        </Card>
    );
}

interface RequestDetailsPageProps {
  initialRequest: RequestDetail | null;
  initialError: string | null;
}

export const getServerSideProps: GetServerSideProps<RequestDetailsPageProps> = async (context) => {
  const session = await getServerSession(context.req, context.res, authOptions);

  if (!session?.user) {
    // Preserve the deep link so that after sign-in (e.g. from an approval
    // email) the approver lands on this request, not the dashboard.
    const reqId = typeof context.query.id === 'string' ? context.query.id : '';
    const callbackUrl = encodeURIComponent(`/requests/${reqId}`);
    return {
      redirect: {
        destination: `/?callbackUrl=${callbackUrl}`,
        permanent: false,
      },
    };
  }

  const user = session.user as any;
  const organizationId = user.org_id;
  const userId = user.id;
  const { id } = context.query;

  if (!id || typeof id !== 'string' || !organizationId) {
    return {
      props: {
        initialRequest: null,
        initialError: 'Invalid request',
      },
    };
  }

  try {
    const { data: request, error } = await supabaseAdmin
      .from('requests')
      .select(`
        id,
        title,
        description,
        status,
        metadata,
        created_at,
        updated_at,
        creator_id,
        creator:app_users!requests_creator_id_fkey (
          id,
          display_name,
          email,
          profile_picture_url,
          department_id,
          job_title
        ),
        request_steps (
          id,
          step_index,
          step_type,
          approver_role,
          approver_user_id,
          status,
          due_at,
          created_at,
          activated_at,
          first_viewed_at,
          last_viewed_at,
          is_redirected,
          original_approver_id,
          redirect_reason,
          delegation_id,
          approver:app_users!request_steps_approver_user_id_fkey (
            id,
            display_name,
            email,
            profile_picture_url,
            job_title
          ),
          original_approver:app_users!request_steps_original_approver_id_fkey (
            id,
            display_name,
            job_title
          ),
          approvals (
            id,
            decision,
            comment,
            signed_at,
            approver:app_users!approvals_approver_id_fkey (
              id,
              display_name,
              email,
              profile_picture_url
            )
          )
        ),
        documents (
          id,
          filename,
          storage_path,
          file_size,
          mime_type,
          created_at
        )
      `)
      .eq('id', id)
      .eq('organization_id', organizationId)
      .single();

    if (error) {
      return {
        props: {
          initialRequest: null,
          initialError: error.code === 'PGRST116' ? 'Request not found' : 'Failed to fetch request',
        },
      };
    }

    // Redirect complimentary request types to the comp/[id] page
    const requestType = request.metadata?.type || request.metadata?.requestType;
    if (requestType === 'hotel_booking' || requestType === 'voucher_request') {
      return {
        redirect: {
          destination: `/requests/comp/${id}`,
          permanent: false,
        },
      };
    }

    // Visibility check
    const isCreator = request.creator_id === userId;
    const watcherIds = request.metadata?.watchers || [];
    const isWatcher = Array.isArray(watcherIds) && watcherIds.some((w: any) => 
      typeof w === 'string' ? w === userId : w?.id === userId
    );
    const userStep = request.request_steps?.find(
      (step: any) => step.approver_user_id === userId
    );
    const canApproverView = userStep && userStep.status !== 'waiting';

    // Privileged view: super users may open any request; finance admins may open
    // any CAPEX (they manage funding from /finance/capex-tracker and need the
    // full request detail). Only resolved when the cheaper checks above fail.
    let canPrivilegedView = false;
    if (!isCreator && !isWatcher && !canApproverView) {
      try {
        const rbac = await getUserRBACProfile(userId);
        canPrivilegedView =
          rbac.is_super_admin ||
          (requestType === 'capex' && hasPermission(rbac, 'finance.view_tracker'));
      } catch {
        canPrivilegedView = false;
      }
    }

    if (!isCreator && !isWatcher && !canApproverView && !canPrivilegedView) {
      return {
        props: {
          initialRequest: null,
          initialError: userStep?.status === 'waiting'
            ? 'This request is not yet ready for your review.'
            : 'You do not have permission to view this request',
        },
      };
    }

    // Sort steps and calculate current step
    if (request.request_steps) {
      request.request_steps.sort((a: any, b: any) => a.step_index - b.step_index);
    }
    const currentStepIndex = request.request_steps?.findIndex((step: any) => step.status === 'pending') ?? -1;
    const currentStep = currentStepIndex >= 0 ? request.request_steps[currentStepIndex] : null;

    // Compute actual status
    const computeActualStatus = (dbStatus: string, steps: any[]) => {
      if (!steps || steps.length === 0) return dbStatus;
      if (steps.some((s: any) => s.status === 'rejected')) return 'rejected';
      if (steps.every((s: any) => s.status === 'approved')) return 'approved';
      if (steps.some((s: any) => s.status === 'pending' || s.status === 'waiting')) return 'pending';
      return dbStatus;
    };
    const actualStatus = computeActualStatus(request.status, request.request_steps);

    // Handle approver - could be array from query
    const rawApprover = currentStep?.approver;
    const currentApprover = Array.isArray(rawApprover) ? rawApprover[0] : rawApprover;

    // Normalize request_steps approvers (could be arrays from query)
    const normalizedSteps = request.request_steps?.map((step: any) => ({
      ...step,
      approver: Array.isArray(step.approver) ? step.approver[0] : step.approver,
      original_approver: Array.isArray(step.original_approver) ? step.original_approver[0] : step.original_approver,
    }));

    // When filed on behalf of a principal, resolve THEIR creator-shaped profile
    // (name, department, business unit) so the Preview tab presents them as the
    // requestor rather than the assistant who filed. Null for normal requests.
    const onBehalfProfile = await resolveOnBehalfProfile(request);

    const enrichedRequest = {
      ...request,
      creator: Array.isArray(request.creator) ? request.creator[0] : request.creator,
      onBehalfProfile: onBehalfProfile || null,
      status: actualStatus as RequestDetail['status'],
      current_step: currentStepIndex >= 0 ? currentStepIndex + 1 : request.request_steps?.length || 0,
      total_steps: request.request_steps?.length || 0,
      current_approver: currentApprover || null,
      request_steps: normalizedSteps,
    };

    return {
      props: {
        initialRequest: enrichedRequest,
        initialError: null,
      },
    };
  } catch (err: any) {
    // Log the real error server-side; never surface a raw message/stack to the UI.
    console.error('Request details getServerSideProps error:', err);
    return {
      props: {
        initialRequest: null,
        initialError: 'We couldn’t load this request. It may have been removed, or you may not have access to it.',
      },
    };
  }
};

export default function RequestDetailsPage({ initialRequest, initialError }: RequestDetailsPageProps) {
    const router = useRouter();
    const { id } = router.query;
    const { data: session, status } = useSession();
    const { addToast } = useToast();
    const [request, setRequest] = useState<RequestDetail | null>(initialRequest);
    const [loading, setLoading] = useState(!initialRequest);
    const [error, setError] = useState<string | null>(initialError);
    // Distinguishes a connectivity failure from a genuine "not found / no
    // access" so the error screen can tell the user it's their connection (and
    // offer a retry) rather than implying the request doesn't exist.
    const [errorIsNetwork, setErrorIsNetwork] = useState(false);
    // Bumped by the "Try again" button to re-run the fetch effect.
    const [retryTick, setRetryTick] = useState(0);
    const [activeTab, setActiveTab] = useState<'preview' | 'details' | 'timeline' | 'documents'>('preview');
    const [publishing, setPublishing] = useState(false);
    const [savingDraft, setSavingDraft] = useState(false);
    const [isEditing, setIsEditing] = useState(false);
    const [editedRequest, setEditedRequest] = useState<RequestDetail | null>(null);
    const [publishError, setPublishError] = useState<string | null>(null);
    const [deleting, setDeleting] = useState(false);
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const [uploadingDocument, setUploadingDocument] = useState(false);
    const [documents, setDocuments] = useState<any[]>([]);
    const [loadingDocuments, setLoadingDocuments] = useState(false);
    const [showReviewModal, setShowReviewModal] = useState(false);
    const [showApprovedPreview, setShowApprovedPreview] = useState(false);
    // Where the approved PDF landed in Microsoft 365 (OneDrive/SharePoint webUrls).
    const [archiveLinks, setArchiveLinks] = useState<{ onedrive?: string; sharepoint?: string; teams?: string } | null>(null);
    const [reviewComment, setReviewComment] = useState('');
    const [reviewProcessing, setReviewProcessing] = useState(false);
    const [reviewError, setReviewError] = useState<string | null>(null);
    const [userSignatureUrl, setUserSignatureUrl] = useState<string | null>(null);
    const [pendingApprovalAction, setPendingApprovalAction] = useState<'approve' | 'reject' | null>(null);
    const [signatureSelection, setSignatureSelection] = useState<SignatureSelection>({ type: 'saved' });
    const [showRejectConfirm, setShowRejectConfirm] = useState(false);
    const [showApproveConfirm, setShowApproveConfirm] = useState(false);

    // Screening (gatekeeping assistant): when this request has a step parked
    // for the current user to screen before their boss sees it, they can
    // Forward it on or Return it to the requestor — same actions as the
    // Approvals › Screening tab, surfaced here on the request itself.
    const [screening, setScreening] = useState<{ stepId: string; bossName: string | null } | null>(null);
    const [screenBusy, setScreenBusy] = useState(false);
    const [screenError, setScreenError] = useState<string | null>(null);
    const [showScreenReturn, setShowScreenReturn] = useState(false);
    const [screenReturnComment, setScreenReturnComment] = useState('');
    const [hrdCostAllocation, setHrdCostAllocation] = useState<Record<string, string>>({
        corp: '', mrc: '', nah: '', rth: '', khcc: '', brh: '', vfrh: '', azam: '',
    });
    // HRD-set category for hotel bookings (Marketing / Admin / Promotions / etc.).
    // The requester no longer picks one on the form — the HRD records the
    // appropriate category alongside the per-unit cost split at approval time.
    const [hrdAllocationCategory, setHrdAllocationCategory] = useState<string>('');
    const [isApproverEditing, setIsApproverEditing] = useState(false);
    const [approverEditedRequest, setApproverEditedRequest] = useState<RequestDetail | null>(null);
    const [savingApproverEdit, setSavingApproverEdit] = useState(false);
    const [modifications, setModifications] = useState<any[]>([]);
    const [loadingModifications, setLoadingModifications] = useState(false);
    const [uploadingApproverDocument, setUploadingApproverDocument] = useState(false);
    const [showUploadModal, setShowUploadModal] = useState(false);
    const [uploadDocumentType, setUploadDocumentType] = useState<'quotation' | 'supporting'>('supporting');
    const [uploadFile, setUploadFile] = useState<File | null>(null);
    const [uploadMetadata, setUploadMetadata] = useState({
        description: '',
        supplierName: '',
        isSelectedSupplier: false,
        selectionReason: '',
    });
    // Resubmission: tracks the in-flight POST while a rejected request is being
    // edited and resent through its approvers. The edit UI itself reuses the
    // existing `isEditing` / `editedRequest` state.
    const [submittingResubmit, setSubmittingResubmit] = useState(false);
    // Cancellation: a requester or approver can cancel at any stage (with a
    // mandatory reason), including after full approval.
    const [showCancelModal, setShowCancelModal] = useState(false);
    const [cancelReason, setCancelReason] = useState('');
    const [cancelling, setCancelling] = useState(false);
    const [unsubmitting, setUnsubmitting] = useState(false);

    const currentUserId = (session?.user as any)?.id;
    // Use the authoritative creator_id (always present) with the embedded
    // creator object only as a fallback. Relying solely on the embed meant the
    // creator's action buttons (Unsubmit & Edit, Cancel, Delete) silently
    // vanished whenever the join wasn't shaped as expected — the action bar is
    // meant to be universal across every request type, CAPEX included.
    const creatorId = request?.creator_id
        || (Array.isArray(request?.creator) ? request?.creator[0]?.id : request?.creator?.id);
    const isCreator = !!currentUserId && creatorId === currentUserId;
    const isDraft = request?.status === 'draft';
    const canPublish = isCreator && isDraft;
    const canDelete = isCreator && request?.status !== 'approved';

    // Price Variation: the creator of a fully-approved CAPEX can raise a price
    // variation against it. On this request being a variation itself, we show a
    // back-link to its parent CAPEX and any recorded variations as a banner.
    const requestKind = request?.metadata?.type || request?.metadata?.requestType;
    const isCapexRequest = requestKind === 'capex';
    const isPriceVariationRequest = requestKind === 'price-variation';
    const canRaisePriceVariation = isCreator && isCapexRequest && request?.status === 'approved';
    const priceVariations: any[] = Array.isArray(request?.metadata?.priceVariations)
        ? request!.metadata.priceVariations
        : [];

    // Check if current user is the pending approver for this request
    // Note: We check if the user has a pending step regardless of request status,
    // because the request status might be incorrectly set to 'approved' due to a previous bug
    const pendingStep = request?.request_steps?.find(
        s => s.approver?.id === currentUserId && s.status === 'pending'
    );

    // Also check if user has a waiting step that should be pending
    // (i.e., all previous steps are approved - handles case where step wasn't activated)
    const waitingStepThatShouldBePending = (() => {
        if (!request?.request_steps) return null;
        const sortedSteps = [...request.request_steps].sort((a, b) => a.step_index - b.step_index);

        for (const step of sortedSteps) {
            if (step.status === 'approved') continue;
            if (step.status === 'rejected') return null; // Request is rejected
            // This is the first non-approved step
            if (step.approver?.id === currentUserId && (step.status === 'pending' || step.status === 'waiting')) {
                return step;
            }
            return null; // First non-approved step is not for this user
        }
        return null;
    })();

    const effectivePendingStep = pendingStep || waitingStepThatShouldBePending;
    const isCurrentApprover = !!effectivePendingStep;

    // Record that the current user opened the request. Server-side this both
    // (a) updates approver view-tracking for the timeline (a no-op for
    // non-approvers) and (b) logs a user-activity audit event for every
    // viewer so the audit "Activity" log captures day-to-day usage. Fires
    // once per page open.
    useEffect(() => {
        if (!id || typeof id !== 'string' || !currentUserId) return;
        fetch(`/api/requests/${id}/view`, { method: 'POST' }).catch(() => { /* silent */ });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [id, currentUserId]);

    // Is this request currently waiting for the signed-in user to SCREEN it
    // (as a gatekeeping assistant) before it reaches the boss? The screening
    // queue endpoint already encodes the gatekeeper authorisation, so we just
    // check whether this request is in it and grab the step id + boss name.
    const loadScreening = useCallback(async () => {
        if (!id || typeof id !== 'string') { setScreening(null); return; }
        try {
            const res = await fetch('/api/approvals/screening');
            if (!res.ok) { setScreening(null); return; }
            const list = await res.json();
            const entry = Array.isArray(list) ? list.find((r: any) => r.id === id) : null;
            setScreening(
                entry
                    ? { stepId: entry.screening_step_id, bossName: entry.screening_boss?.name || null }
                    : null
            );
        } catch {
            setScreening(null);
        }
    }, [id]);

    useEffect(() => {
        loadScreening();
        // Re-check when the request status changes (e.g. after forwarding it on).
    }, [loadScreening, request?.status]);

    const handleScreenForward = async () => {
        if (!screening) return;
        setScreenBusy(true);
        setScreenError(null);
        try {
            const res = await fetch('/api/approvals/screen', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ requestId: id, stepId: screening.stepId, action: 'forward' }),
            });
            if (!res.ok) throw new Error((await res.json()).error || 'Failed to forward');
            addToast({
                type: 'success',
                title: 'Forwarded for approval',
                message: `Sent to ${screening.bossName || 'the approver'}.`,
            });
            const r = await fetch(`/api/requests/${id}`);
            if (r.ok) setRequest((await r.json()).request);
            await loadScreening();
        } catch (e: any) {
            setScreenError(e?.message || 'Failed to forward');
        } finally {
            setScreenBusy(false);
        }
    };

    const submitScreenReturn = async () => {
        if (!screening || !screenReturnComment.trim()) return;
        setScreenBusy(true);
        setScreenError(null);
        try {
            const res = await fetch('/api/approvals/screen', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    requestId: id,
                    stepId: screening.stepId,
                    action: 'return',
                    comment: screenReturnComment.trim(),
                }),
            });
            if (!res.ok) throw new Error((await res.json()).error || 'Failed to return');
            addToast({
                type: 'success',
                title: 'Returned to requestor',
                message: 'The requester has been notified to amend and resubmit.',
            });
            setShowScreenReturn(false);
            setScreenReturnComment('');
            const r = await fetch(`/api/requests/${id}`);
            if (r.ok) setRequest((await r.json()).request);
            await loadScreening();
        } catch (e: any) {
            setScreenError(e?.message || 'Failed to return');
        } finally {
            setScreenBusy(false);
        }
    };

    // Travel authorisations and hotel bookings both require HRD cost allocation.
    // Travel auths always carry a grand total to allocate against; hotel
    // bookings with a bundled travel document do too. Pure complimentary
    // hotel bookings (no travel doc) still show the HRD allocation UI so
    // the HRD signs off on which units carry the room comp — but without
    // a grand-total to balance against, the validation is relaxed to "any
    // non-zero allocation is acceptable".
    const requestType = request?.metadata?.type;
    const isHotelBooking = requestType === 'hotel_booking' || requestType === 'external_hotel_booking';
    // Travel authorisations now capture cost allocation on the FORM itself
    // (entered by the requestor — see /requests/new/travel-auth), so the
    // CHCO/HRD no longer allocates cost at approval time. Hotel bookings still
    // require the HRD to sign off on which units carry the comp value.
    const requestRequiresTravelCostAllocation = !!isHotelBooking;
    const isHrdApprovingTravelAuth = !!(
        effectivePendingStep &&
        requestRequiresTravelCostAllocation &&
        request?.metadata?.approverRoles?.hrd &&
        request.metadata.approverRoles.hrd === currentUserId
    );
    const travelAuthGrandTotal = parseFloat(request?.metadata?.grandTotal || '0') || 0;
    const hotelHasTravelDoc = isHotelBooking && !!request?.metadata?.processTravelDocument;
    /** Whether we can balance the allocation against a precomputed total.
     *  Travel auths always have one; hotel bookings only have one when a
     *  travel doc is bundled with the comp request. */
    const hasGrandTotalToBalance = travelAuthGrandTotal > 0 && (
        requestType === 'travel_authorization' ||
        requestType === 'international_travel_authorization' ||
        hotelHasTravelDoc
    );
    /** Business unit codes that actually appeared in the itinerary (from / to).
     *  When the HRD allocates costs, we only show inputs for these units —
     *  irrelevant units stay zero and would otherwise clutter the form.
     *  'corp' is always included as a catch-all bucket for non-unit costs.
     *  For pure hotel bookings (no itinerary), we derive the relevant set
     *  from `selectedBusinessUnits` (the units being booked) instead. */
    const relevantTravelUnits: ReadonlyArray<'corp'|'mrc'|'nah'|'rth'|'khcc'|'brh'|'vfrh'|'azam'> = (() => {
        const itinerary = (request?.metadata?.itinerary || []) as Array<{ from?: string; to?: string }>;
        const bookedUnits = (request?.metadata?.selectedBusinessUnits || []) as Array<{ code?: string; name?: string }>;
        const codes = new Set<string>();
        for (const row of itinerary) {
            if (typeof row.from === 'string') codes.add(row.from.toLowerCase());
            if (typeof row.to === 'string') codes.add(row.to.toLowerCase());
        }
        for (const bu of bookedUnits) {
            const code = (bu?.code || bu?.name || '').toLowerCase();
            if (code) codes.add(code);
        }
        const allUnits = ['corp','mrc','nah','rth','khcc','brh','vfrh','azam'] as const;
        const filtered = allUnits.filter(u => u === 'corp' || codes.has(u));
        return filtered.length > 1 ? filtered : allUnits;
    })();
    const hrdAllocationSum = (['corp','mrc','nah','rth','khcc','brh','vfrh','azam'] as const)
        .reduce((sum, k) => sum + (parseFloat(hrdCostAllocation[k] || '0') || 0), 0);
    const hrdAllocationValid = isHrdApprovingTravelAuth
        ? (hasGrandTotalToBalance
            ? Math.abs(hrdAllocationSum - travelAuthGrandTotal) < 0.01 && travelAuthGrandTotal > 0
            : hrdAllocationSum > 0)
        : true;

    // Check if current user is a watcher (watchers can only view, not edit)
    const watchersData = Array.isArray(request?.metadata?.watchers) ? request.metadata.watchers : [];
    const isWatcher = watchersData.some((w: any) => 
        typeof w === 'string' ? w === currentUserId : w.id === currentUserId
    );

    // Approvers can edit, watchers cannot
    const canApproverEdit = isCurrentApprover && !isWatcher;

    // Compute the actual status based on step statuses (to handle incorrectly marked requests)
    const computeActualStatus = (): string | undefined => {
        if (!request) return undefined;
        // Terminal / non-active statuses win over any leftover step states
        // (cancelling/withdrawing does not clear the steps).
        if (['cancelled', 'withdrawn', 'draft', 'expired'].includes(request.status)) return request.status;
        const steps = request.request_steps || [];
        if (steps.length === 0) return request.status;

        // If any step is rejected, the request is rejected
        if (steps.some(s => s.status === 'rejected')) return 'rejected';

        // If all steps are approved, the request is approved
        if (steps.every(s => s.status === 'approved')) return 'approved';

        // If there are pending or waiting steps, the request is still in progress
        if (steps.some(s => s.status === 'pending' || s.status === 'waiting')) return 'pending';

        return request.status;
    };
    const actualStatus = computeActualStatus();

    // Resubmission affordance: the creator of a rejected request may edit it
    // and send it back through the approval chain (see /api/requests/[id]/resubmit).
    const canResubmit = isCreator && (actualStatus || request?.status) === 'rejected';
    const isResubmitting = isEditing && canResubmit;

    // Details of the rejection that is currently blocking the request — used to
    // surface the reason to the requester and inside the resubmission editor.
    const rejectedStepInfo = (() => {
        const step = (request?.request_steps || []).find(s => s.status === 'rejected');
        if (!step) return null;
        const approval = step.approvals?.find((a: any) => a.decision === 'rejected') || step.approvals?.[0];
        return {
            comment: approval?.comment || null,
            approverName: step.approver?.display_name || approval?.approver?.display_name || 'An approver',
            signedAt: approval?.signed_at || null,
        };
    })();

    // Cancellation: either the requester or any approver on the request may
    // cancel it, at any stage — including after it is fully approved. The only
    // states that can't be cancelled are already-cancelled and withdrawn.
    const isApprover = (request?.request_steps || []).some(s => s.approver?.id === currentUserId);
    const cancellableStatus = !!request && !['cancelled', 'withdrawn', 'draft'].includes(actualStatus || request.status);
    const canCancel = (isCreator || isApprover) && cancellableStatus;
    const cancellationInfo = (request?.metadata?.cancellation as any) || null;

    // Anyone within the request's scope (creator, any approver, per-request
    // watcher) can upload supporting documents — matches the server rule in
    // /api/requests/[id]/documents. Permanent watchers stay read-only.
    const canUploadDoc = isCreator || isApprover || isWatcher;

    // Unsubmit & amend: the creator may pull a still-pending request back to an
    // editable draft — but only while NO approver has acted yet (see
    // /api/requests/[id]/unsubmit). After unsubmitting we route straight into
    // the form to amend, then republish.
    const noApproverActed = !(request?.request_steps || []).some(
        s => s.status === 'approved' || s.status === 'rejected'
    );
    const canUnsubmit = isCreator && (actualStatus || request?.status) === 'pending' && noApproverActed;

    // Reopen (revive) a cancelled request: the creator can pull it back to an
    // editable draft and resubmit — unless it had been fully approved before
    // it was cancelled. Reuses the same /unsubmit route + edit flow.
    const canRevive = isCreator
        && (actualStatus || request?.status) === 'cancelled'
        && (request?.metadata?.cancellation?.previousStatus !== 'approved');

    // Seed HRD cost allocation from existing metadata when opening modal
    useEffect(() => {
        if (showReviewModal && isHrdApprovingTravelAuth) {
            const existing = (request?.metadata?.costAllocation || {}) as Record<string, string>;
            setHrdCostAllocation({
                corp: existing.corp || '',
                mrc: existing.mrc || '',
                nah: existing.nah || '',
                rth: existing.rth || '',
                khcc: existing.khcc || '',
                brh: existing.brh || '',
                vfrh: existing.vfrh || '',
                azam: existing.azam || '',
            });
            // Also seed the comp-booking category (hotel bookings only).
            setHrdAllocationCategory(request?.metadata?.allocationType || '');
        }
    }, [showReviewModal, isHrdApprovingTravelAuth, request?.metadata?.costAllocation, request?.metadata?.allocationType]);

    // Fetch user's signature when modal opens
    useEffect(() => {
        if (showReviewModal && currentUserId) {
            fetch('/api/user/signature')
                .then(res => res.json())
                .then(data => {
                    const url = data.signature_url || data.signature?.url;
                    if (url) {
                        setUserSignatureUrl(url);
                    }
                })
                .catch(err => console.error('Error fetching signature:', err));
        }
    }, [showReviewModal, currentUserId]);

    const handleApprovalAction = async (action: 'approve' | 'reject') => {
        if (!id || !effectivePendingStep) return;

        if (action === 'reject' && !reviewComment.trim()) {
            setReviewError('Please provide a reason for rejection');
            return;
        }

        if (action === 'approve' && isHrdApprovingTravelAuth) {
            if (!hrdAllocationValid) {
                setReviewError(
                    hasGrandTotalToBalance
                        ? `Cost allocation must total ${travelAuthGrandTotal.toFixed(2)} ` +
                          `(currently ${hrdAllocationSum.toFixed(2)}). Please allocate the full amount before approving.`
                        : 'Please record a cost allocation (at least one unit must be greater than zero) before approving.'
                );
                return;
            }
            if (isHotelBooking && !hrdAllocationCategory) {
                setReviewError('Please select an allocation category (Marketing, Administration, etc.) before approving.');
                return;
            }
        }

        if (action === 'approve') {
            // Validate signature selection
            if (signatureSelection.type === 'saved' && !userSignatureUrl) {
                setReviewError('You need to set up your signature before approving. Go to Profile > Signature.');
                return;
            }
            if (signatureSelection.type === 'manual' && !signatureSelection.data) {
                setReviewError('Please draw your signature before approving.');
                return;
            }
        }

        // Identity re-verification (biometric / Microsoft MFA step-up) is not
        // used, but the approver still confirms the decision in a lightweight
        // dialog before it is recorded. Reject already routes through its own
        // confirmation (showRejectConfirm) before reaching here, so only the
        // approve path needs to open the confirm dialog.
        if (action === 'approve') {
            setReviewError(null);
            setShowApproveConfirm(true);
            return;
        }
        await submitDecision(action);
    };

    const submitDecision = async (action: 'approve' | 'reject') => {
        if (!id || !effectivePendingStep) return;

        setPendingApprovalAction(action);
        setReviewProcessing(true);
        setReviewError(null);

        try {
            const body: Record<string, any> = {
                requestId: id,
                stepId: effectivePendingStep.id,
                action,
                comment: reviewComment || undefined,
                authMethod: 'session',
                signatureType: signatureSelection.type,
                deviceInfo: {
                    userAgent: navigator.userAgent,
                    platform: navigator.platform,
                    language: navigator.language,
                    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                },
            };

            // For manual signatures, include the data URL
            if (signatureSelection.type === 'manual' && signatureSelection.data) {
                body.signatureData = signatureSelection.data;
            }

            // HRD cost allocation for travel_authorization approvals
            if (isHrdApprovingTravelAuth && action === 'approve') {
                body.costAllocation = hrdCostAllocation;
                // For hotel bookings the HRD also picks the category that
                // used to be on the form. Pass it through so the action
                // endpoint can persist it into metadata.
                if (isHotelBooking) {
                    body.allocationType = hrdAllocationCategory;
                }
            }

            const response = await fetch('/api/approvals/action', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });

            if (!response.ok) {
                let actionError = `Failed to ${action} request`;
                try {
                    const errorData = await response.json();
                    actionError = errorData.error || actionError;
                } catch {
                    // Gateway/proxy returned non-JSON (5xx) — the request likely
                    // didn't reach the app. Tell the user it's a connection issue.
                    if (response.status >= 500) {
                        actionError = "Couldn't reach the server to record your decision. Please check your connection and try again.";
                    }
                }
                throw new Error(actionError);
            }

            // Refresh the request data
            const refreshResponse = await fetch(`/api/requests/${id}`);
            if (refreshResponse.ok) {
                const refreshData = await refreshResponse.json();
                setRequest(refreshData.request);
            }

            setShowReviewModal(false);
            setReviewComment('');
            setPendingApprovalAction(null);
            setSignatureSelection({ type: 'saved' });
        } catch (err: any) {
            setReviewError(getErrorMessage(err, `Failed to ${action} request`));
        } finally {
            setReviewProcessing(false);
        }
    };

    const handlePublish = async () => {
        if (!id || !canPublish) return;

        setPublishing(true);
        setPublishError(null);

        try {
            const response = await fetch(`/api/requests/${id}/publish`, {
                method: 'POST',
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || 'Failed to publish request');
            }

            // Refresh the request data
            const refreshResponse = await fetch(`/api/requests/${id}`);
            if (refreshResponse.ok) {
                const refreshData = await refreshResponse.json();
                setRequest(refreshData.request);
            }

            router.push('/requests/my-requests');
        } catch (err: any) {
            console.error('Error publishing request:', err);
            setPublishError(err.message || 'Failed to publish request');
        } finally {
            setPublishing(false);
        }
    };

    const handleSaveDraft = async () => {
        if (!id || !canPublish || !editedRequest) return;

        setSavingDraft(true);
        setPublishError(null);

        try {
            const response = await fetch(`/api/requests/${id}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    title: editedRequest.title,
                    description: editedRequest.description,
                    metadata: editedRequest.metadata,
                    status: 'draft',
                }),
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || 'Failed to save draft');
            }

            // Refresh the request data
            const refreshResponse = await fetch(`/api/requests/${id}`);
            if (refreshResponse.ok) {
                const refreshData = await refreshResponse.json();
                setRequest(refreshData.request);
                setIsEditing(false);
            }
        } catch (err: any) {
            console.error('Error saving draft:', err);
            setPublishError(err.message || 'Failed to save draft');
        } finally {
            setSavingDraft(false);
        }
    };

    // Request types whose dedicated form page supports `?edit=<id>` creator
    // editing. For these we route the requester through the full structured
    // form (which PUTs to /api/requests/[id]; the API treats a rejected-request
    // edit as a resubmission). Types not listed here fall back to the inline
    // editor below.
    const RESUBMIT_FORM_ROUTES: Record<string, string> = {
        capex: 'capex',
        travel_authorization: 'travel-auth',
        international_travel_authorization: 'international-travel-auth',
        petty_cash: 'petty-cash',
        journal_entry: 'journals',
        journals: 'journals',
        inter_unit_debit_note: 'inter-unit-debit-note',
        inter_unit_credit_note: 'inter-unit-credit-note',
        external_hotel_booking: 'external-comp-booking',
        external_comp_booking: 'external-comp-booking',
    };

    // Enter the inline "edit & resubmit" flow for a rejected request. Reuses the
    // existing inline-edit state (title/description in the header, form fields
    // in the Details tab) and jumps the user straight to the editable fields.
    const startResubmit = () => {
        if (!request || !canResubmit) return;
        setPublishError(null);
        setEditedRequest(JSON.parse(JSON.stringify(request)));
        setIsEditing(true);
        setActiveTab('details');
    };

    // Entry point for "Edit & Resubmit". Prefer the request's full form (so the
    // requester can re-edit structured data like budgets and itineraries);
    // fall back to the lightweight inline editor for types without an
    // edit-capable form page.
    const beginResubmit = () => {
        if (!request || !canResubmit) return;
        const requestType = request.metadata?.type || request.metadata?.requestType;
        const route = requestType ? RESUBMIT_FORM_ROUTES[requestType] : undefined;
        if (route) {
            router.push(`/requests/new/${route}?edit=${id}`);
            return;
        }
        startResubmit();
    };

    const cancelResubmit = () => {
        setIsEditing(false);
        setEditedRequest(null);
        setPublishError(null);
    };

    // Collect the edits and resubmit the rejected request. The server versions
    // the reference (-R{n}), preserves the rejection history, rebuilds the
    // approval steps and re-notifies the approver(s).
    const handleResubmit = async () => {
        if (!id || !canResubmit || !editedRequest || !request) return;

        setSubmittingResubmit(true);
        setPublishError(null);

        try {
            // Diff the editable (scalar) form fields against the original.
            const originalFormData = getFormData(request.metadata);
            const editedFormData = getFormData(editedRequest.metadata);
            const fieldChanges: { fieldName: string; oldValue: any; newValue: any }[] = [];
            for (const key of Object.keys(editedFormData)) {
                const value = editedFormData[key];
                if (value !== null && value !== undefined && typeof value === 'object') continue;
                if (String(value ?? '') !== String(originalFormData[key] ?? '')) {
                    fieldChanges.push({ fieldName: key, oldValue: originalFormData[key], newValue: value });
                }
            }

            const response = await fetch(`/api/requests/${id}/resubmit`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title: editedRequest.title,
                    description: editedRequest.description,
                    fieldChanges,
                }),
            });

            const data = await response.json();
            if (!response.ok) {
                throw new Error(data.error || 'Failed to resubmit request');
            }

            addToast({
                type: 'success',
                title: 'Request resubmitted',
                message: data.newReference
                    ? `Sent back to your approvers as ${data.newReference}.`
                    : 'Sent back to your approvers for review.',
            });

            // Refresh the request and its modification history.
            const refreshResponse = await fetch(`/api/requests/${id}`);
            if (refreshResponse.ok) {
                const refreshData = await refreshResponse.json();
                setRequest(refreshData.request);
            }
            await fetchModifications();

            setIsEditing(false);
            setEditedRequest(null);
            setActiveTab('timeline');
        } catch (err: any) {
            console.error('Error resubmitting request:', err);
            setPublishError(err.message || 'Failed to resubmit request');
            addToast({
                type: 'error',
                title: 'Resubmission failed',
                message: err.message || 'Failed to resubmit request',
            });
        } finally {
            setSubmittingResubmit(false);
        }
    };

    // Cancel the request (requester or approver) with a mandatory reason.
    const handleCancel = async () => {
        if (!id || !canCancel) return;
        const reason = cancelReason.trim();
        if (!reason) {
            addToast({ type: 'error', title: 'Reason required', message: 'Please provide a reason for cancelling.' });
            return;
        }
        setCancelling(true);
        try {
            const response = await fetch(`/api/requests/${id}/cancel`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reason }),
            });
            const data = await response.json();
            if (!response.ok) {
                throw new Error(data.error || 'Failed to cancel request');
            }

            addToast({
                type: 'success',
                title: 'Request cancelled',
                message: 'The request has been cancelled and the other parties notified.',
            });

            const refreshResponse = await fetch(`/api/requests/${id}`);
            if (refreshResponse.ok) {
                const refreshData = await refreshResponse.json();
                setRequest(refreshData.request);
            }
            await fetchModifications();

            setShowCancelModal(false);
            setCancelReason('');
        } catch (err: any) {
            console.error('Error cancelling request:', err);
            addToast({
                type: 'error',
                title: 'Cancellation failed',
                message: err.message || 'Failed to cancel request',
            });
        } finally {
            setCancelling(false);
        }
    };

    // Unsubmit & amend: pull the pending request back to a draft, then route the
    // requester into the original form (?edit=) to amend and republish. Falls
    // back to the request page (draft) when the type has no edit-capable form.
    const handleUnsubmit = async () => {
        if (!id || (!canUnsubmit && !canRevive)) return;
        setUnsubmitting(true);
        setPublishError(null);
        try {
            const response = await fetch(`/api/requests/${id}/unsubmit`, { method: 'POST' });
            const data = await response.json();
            if (!response.ok) {
                throw new Error(data.error || 'Failed to unsubmit request');
            }

            addToast({
                type: 'success',
                title: canRevive ? 'Request reopened' : 'Request unsubmitted',
                message: 'Amend your request, then submit it again for approval.',
            });

            const requestType = request?.metadata?.type || request?.metadata?.requestType;
            const route = requestType ? RESUBMIT_FORM_ROUTES[requestType] : undefined;
            if (route) {
                router.push(`/requests/new/${route}?edit=${id}`);
            } else {
                // No dedicated form — reload as a draft; inline edit + Submit apply.
                const refreshResponse = await fetch(`/api/requests/${id}`);
                if (refreshResponse.ok) {
                    const refreshData = await refreshResponse.json();
                    setRequest(refreshData.request);
                }
            }
        } catch (err: any) {
            console.error('Error unsubmitting request:', err);
            addToast({
                type: 'error',
                title: 'Unsubmit failed',
                message: err.message || 'Failed to unsubmit request',
            });
        } finally {
            setUnsubmitting(false);
        }
    };

    const handleMetadataChange = (key: string, value: any) => {
        if (!editedRequest || !editedRequest.metadata) return;

        const newMetadata = { ...editedRequest.metadata };

        // Find the correct form type (capex, leave, etc)
        const formTypes = ['capex', 'leave', 'travel', 'expense', 'approval'];
        let found = false;

        for (const formType of formTypes) {
            if (newMetadata[formType] && typeof newMetadata[formType] === 'object') {
                newMetadata[formType] = { ...newMetadata[formType], [key]: value };
                found = true;
                break;
            }
        }

        // If not found in nested, update root metadata
        if (!found) {
            newMetadata[key] = value;
        }

        setEditedRequest({ ...editedRequest, metadata: newMetadata });
    };

    const handleDelete = async () => {
        if (!id || !canDelete) return;

        setDeleting(true);
        setPublishError(null);

        try {
            const response = await fetch(`/api/requests/${id}`, {
                method: 'DELETE',
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || 'Failed to delete request');
            }

            router.push('/requests/my-requests');
        } catch (err: any) {
            console.error('Error deleting request:', err);
            setPublishError(err.message || 'Failed to delete request');
            setShowDeleteConfirm(false);
        } finally {
            setDeleting(false);
        }
    };

    useEffect(() => {
        if (status === 'unauthenticated') {
            router.push('/');
        }
    }, [status, router]);

    useEffect(() => {
        async function fetchRequestDetails() {
            if (!id || status !== 'authenticated') return;
            // Skip if we already have initial data and id hasn't changed
            if (initialRequest && initialRequest.id === id) {
                setLoading(false);
                return;
            }

            setLoading(true);
            try {
                const response = await fetch(`/api/requests/${id}`);

                if (!response.ok) {
                    let errorMessage = 'Failed to fetch request';
                    try {
                        const errorData = await response.json();
                        errorMessage = errorData.error || errorMessage;
                    } catch {
                        // A non-JSON body (e.g. a 502/504 HTML gateway page) means
                        // the server/gateway is unreachable — treat as a connection
                        // problem rather than a missing request.
                        if (response.status >= 500) {
                            setErrorIsNetwork(true);
                            setError("Can't reach the server right now. Please try again in a moment.");
                            return;
                        }
                    }
                    throw new Error(errorMessage);
                }

                const data = await response.json();
                setRequest(data.request);
                setError(null);
                setErrorIsNetwork(false);
            } catch (err: any) {
                console.error('Error fetching request:', err);
                const network = isNetworkError(err);
                setErrorIsNetwork(network);
                setError(getErrorMessage(err, 'Failed to load request details. Please try again.'));
            } finally {
                setLoading(false);
            }
        }

        fetchRequestDetails();
    }, [id, status, initialRequest, retryTick]);

    useEffect(() => {
        if (request) {
            setEditedRequest(JSON.parse(JSON.stringify(request)));
            setApproverEditedRequest(JSON.parse(JSON.stringify(request)));
        }
    }, [request]);

    // Fetch modifications when request loads
    const fetchModifications = async () => {
        if (!id) return;
        setLoadingModifications(true);
        try {
            const response = await fetch(`/api/requests/${id}/modifications`);
            if (response.ok) {
                const data = await response.json();
                setModifications(data.modifications || []);
            }
        } catch (err) {
            console.error('Error fetching modifications:', err);
        } finally {
            setLoadingModifications(false);
        }
    };

    useEffect(() => {
        if (id && request) {
            fetchModifications();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [id, request]);

    // Handle approver metadata change
    const handleApproverMetadataChange = (key: string, value: any) => {
        if (!approverEditedRequest || !approverEditedRequest.metadata) return;

        const newMetadata = { ...approverEditedRequest.metadata };
        const formTypes = ['capex', 'leave', 'travel', 'expense', 'approval'];
        let found = false;

        for (const formType of formTypes) {
            if (newMetadata[formType] && typeof newMetadata[formType] === 'object') {
                newMetadata[formType] = { ...newMetadata[formType], [key]: value };
                found = true;
                break;
            }
        }

        if (!found) {
            newMetadata[key] = value;
        }

        setApproverEditedRequest({ ...approverEditedRequest, metadata: newMetadata });
    };

    // Save approver edits
    const handleSaveApproverEdit = async () => {
        if (!id || !canApproverEdit || !approverEditedRequest || !request) return;

        setSavingApproverEdit(true);
        setPublishError(null);

        try {
            // Collect field changes
            const originalFormData = getFormData(request.metadata);
            const editedFormData = getFormData(approverEditedRequest.metadata);
            const fieldChanges: { fieldName: string; oldValue: any; newValue: any }[] = [];

            // Compare form data fields
            for (const key of Object.keys(editedFormData)) {
                if (editedFormData[key] !== originalFormData[key]) {
                    fieldChanges.push({
                        fieldName: key,
                        oldValue: originalFormData[key],
                        newValue: editedFormData[key],
                    });
                }
            }

            if (fieldChanges.length === 0) {
                setIsApproverEditing(false);
                return;
            }

            const response = await fetch(`/api/requests/${id}/approver-edit`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ fieldChanges }),
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || 'Failed to save changes');
            }

            // Refresh the request data
            const refreshResponse = await fetch(`/api/requests/${id}`);
            if (refreshResponse.ok) {
                const refreshData = await refreshResponse.json();
                setRequest(refreshData.request);
            }

            // Refresh modifications
            await fetchModifications();

            setIsApproverEditing(false);
        } catch (err: any) {
            console.error('Error saving approver edit:', err);
            setPublishError(err.message || 'Failed to save changes');
        } finally {
            setSavingApproverEdit(false);
        }
    };

    // Handle file selection for upload modal
    const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) {
            setUploadFile(file);
            setShowUploadModal(true);
        }
        e.target.value = '';
    };

    // Handle document upload with metadata
    const handleUploadWithMetadata = async () => {
        if (!uploadFile || !id) return;

        const isApprover = canApproverEdit;
        if (isApprover) {
            setUploadingApproverDocument(true);
        } else {
            setUploadingDocument(true);
        }

        try {
            const formData = new FormData();
            formData.append('file', uploadFile);
            formData.append('documentType', uploadDocumentType);
            formData.append('description', uploadMetadata.description);
            if (uploadDocumentType === 'quotation') {
                formData.append('supplierName', uploadMetadata.supplierName);
                formData.append('isSelectedSupplier', String(uploadMetadata.isSelectedSupplier));
                formData.append('selectionReason', uploadMetadata.selectionReason);
            }

            const endpoint = isApprover 
                ? `/api/requests/${id}/approver-documents`
                : `/api/requests/${id}/documents`;

            const response = await fetch(endpoint, {
                method: 'POST',
                body: formData,
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || 'Failed to upload document');
            }

            // Also update request metadata to include document details
            const currentMetadata = request?.metadata || {};
            const uploaderInfo = {
                id: currentUserId,
                name: (session?.user as any)?.name || 'Unknown',
                isApprover: isApprover,
            };
            const docMetadata = {
                name: uploadFile.name,
                size: uploadFile.size,
                type: uploadFile.type,
                description: uploadMetadata.description,
                uploadedBy: uploaderInfo,
                uploadedAt: new Date().toISOString(),
                ...(uploadDocumentType === 'quotation' && {
                    supplierName: uploadMetadata.supplierName,
                    isSelectedSupplier: uploadMetadata.isSelectedSupplier,
                    selectionReason: uploadMetadata.selectionReason,
                }),
            };

            // Update metadata based on document type
            const updatedMetadata = { ...currentMetadata };
            if (uploadDocumentType === 'quotation') {
                updatedMetadata.quotations = [...(currentMetadata.quotations || []), docMetadata];
            } else {
                updatedMetadata.supportingDocuments = [...(currentMetadata.supportingDocuments || []), docMetadata];
            }

            // Save updated metadata
            await fetch(`/api/requests/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ metadata: updatedMetadata }),
            });

            // Refresh documents and modifications
            await fetchDocuments();
            if (isApprover) {
                await fetchModifications();
            }
            
            // Refresh request data by re-fetching
            const reqResponse = await fetch(`/api/requests/${id}`);
            if (reqResponse.ok) {
                const reqData = await reqResponse.json();
                setRequest(reqData.request);
            }

            // Reset modal state
            setShowUploadModal(false);
            setUploadFile(null);
            setUploadMetadata({
                description: '',
                supplierName: '',
                isSelectedSupplier: false,
                selectionReason: '',
            });
            setUploadDocumentType('supporting');
        } catch (err: any) {
            console.error('Error uploading document:', err);
            setPublishError(err.message || 'Failed to upload document');
        } finally {
            setUploadingApproverDocument(false);
            setUploadingDocument(false);
        }
    };

    // Fetch documents when switching to documents tab or when request loads
    const fetchDocuments = async () => {
        if (!id) return;

        setLoadingDocuments(true);
        try {
            const response = await fetch(`/api/requests/${id}/documents`);
            if (response.ok) {
                const data = await response.json();
                setDocuments(data.documents || []);
            } else {
                console.error('Failed to fetch documents:', response.status);
            }
        } catch (err) {
            console.error('Error fetching documents:', err);
        } finally {
            setLoadingDocuments(false);
        }
    };

    useEffect(() => {
        if (activeTab === 'documents' && id) {
            fetchDocuments();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [id, activeTab]);

    const handleDownloadPdf = () => {
        if (!id) return;
        window.open(`/api/requests/${id}/pdf`, '_blank');
    };

    // Once fully approved, fetch the archive record so we can surface the
    // OneDrive/SharePoint copies alongside the manual download. This also
    // pre-warms the archive for older requests (the endpoint generates it on
    // demand when missing).
    useEffect(() => {
        if (!id || request?.status !== 'approved') return;
        let cancelled = false;
        (async () => {
            try {
                const res = await fetch(`/api/requests/${id}/archive`);
                if (!res.ok) return;
                const data = await res.json();
                if (!cancelled && data?.archive?.microsoft_links) {
                    setArchiveLinks(data.archive.microsoft_links);
                }
            } catch {
                // Non-fatal — the Download button still works via its own fetch.
            }
        })();
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [id, request?.status]);


    const handleDocumentUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file || !id) return;

        setUploadingDocument(true);
        try {
            const formData = new FormData();
            formData.append('file', file);

            const response = await fetch(`/api/requests/${id}/documents`, {
                method: 'POST',
                body: formData,
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || 'Failed to upload document');
            }

            // Refresh the documents list after successful upload
            await fetchDocuments();
        } catch (err: any) {
            console.error('Error uploading document:', err);
            setPublishError(err.message || 'Failed to upload document');
        } finally {
            setUploadingDocument(false);
            e.target.value = '';
        }
    };

    const handleDocumentDownload = async (doc: any) => {
        if (doc.download_url) {
            window.open(doc.download_url, '_blank');
        }
    };

    const handleDocumentDelete = async (documentId: string) => {
        if (!id || !confirm('Are you sure you want to delete this document?')) return;

        try {
            const response = await fetch(`/api/requests/${id}/documents?documentId=${documentId}`, {
                method: 'DELETE',
            });

            if (!response.ok) {
                throw new Error('Failed to delete document');
            }

            setDocuments(prev => prev.filter(d => d.id !== documentId));
        } catch (err: any) {
            console.error('Error deleting document:', err);
            setPublishError(err.message || 'Failed to delete document');
        }
    };

    if (status === 'loading' || loading) {
        return (
            <AppLayout title="Request Details">
                <div className="flex flex-col items-center justify-center min-h-[60vh]">
                    <div className="relative w-16 h-16">
                        <div className="absolute top-0 left-0 w-full h-full border-4 border-gray-200 rounded-full"></div>
                        <div className="absolute top-0 left-0 w-full h-full border-4 border-primary-500 rounded-full border-t-transparent animate-spin"></div>
                    </div>
                    <p className="mt-4 text-gray-400 font-medium animate-pulse">Loading request details...</p>
                </div>
            </AppLayout>
        );
    }

    if (error || !request) {
        // A connectivity failure is NOT a missing request — say so plainly and
        // let the user retry without navigating away and losing their place.
        if (errorIsNetwork) {
            return (
                <AppLayout title="Connection problem">
                    <div className="p-6 max-w-4xl mx-auto">
                        <Card className="text-center py-16 px-8">
                            <div className="w-20 h-20 bg-warning-50 rounded-full flex items-center justify-center mx-auto mb-6">
                                <svg className="w-10 h-10 text-warning-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M18.364 5.636a9 9 0 010 12.728m-12.728 0a9 9 0 010-12.728m9.9 2.829a5 5 0 010 7.07m-7.072 0a5 5 0 010-7.07M12 15a1 1 0 100-2 1 1 0 000 2z" />
                                </svg>
                            </div>
                            <h3 className="text-2xl font-bold text-text-primary mb-2">Connection problem</h3>
                            <p className="text-text-secondary max-w-md mx-auto mb-8">
                                {error || "We couldn't reach the server. The system is working — please check your internet connection and try again."}
                            </p>
                            <div className="flex items-center justify-center gap-3">
                                <Button variant="primary" onClick={() => setRetryTick((t) => t + 1)}>
                                    Try again
                                </Button>
                                <Button variant="secondary" onClick={() => router.push('/requests/my-requests')}>
                                    Back to My Requests
                                </Button>
                            </div>
                        </Card>
                    </div>
                </AppLayout>
            );
        }

        return (
            <AppLayout title="Error">
                <div className="p-6 max-w-4xl mx-auto">
                    <Card className="text-center py-16 px-8">
                        <div className="w-20 h-20 bg-danger-50 rounded-full flex items-center justify-center mx-auto mb-6">
                            <svg className="w-10 h-10 text-danger-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                            </svg>
                        </div>
                        <h3 className="text-2xl font-bold text-text-primary mb-2">Request Not Found</h3>
                        <p className="text-text-secondary max-w-md mx-auto mb-8">{error || "The request you are looking for specific request ID does not exist or you do not have permission to view it."}</p>
                        <Button variant="primary" onClick={() => router.push('/requests/my-requests')}>
                            Back to My Requests
                        </Button>
                    </Card>
                </div>
            </AppLayout>
        );
    }

    // Use actualStatus for display to handle incorrectly marked requests
    const statusInfo = statusConfig[actualStatus || request.status] || statusConfig.pending;

    const priority = request.metadata?.priority || 'normal';
    // Urgency banner + pulsing border should only run while the request still
    // needs action — stop it once the request is resolved (approved/rejected/etc).
    const displayStatus = actualStatus || request.status;
    const isResolvedStatus = ['approved', 'rejected', 'withdrawn', 'cancelled', 'completed'].includes(displayStatus);
    const isCritical = priority === 'critical' && !isResolvedStatus;
    const isHighPriority = priority === 'high' && !isResolvedStatus;

    return (
        <AppLayout title={`Request #${request.id.substring(0, 8)}`}>
            <style dangerouslySetInnerHTML={{ __html: pulseKeyframes }} />

            {/* Form-style preview — available at any status so the requester and
                approvers can see the formatted document, with approval signatures
                appended (the signature section just renders the approvals that
                exist so far, which is exactly what we want for in-progress review). */}
            {request && (
                <ApprovedRequestPreview
                    isOpen={showApprovedPreview}
                    onClose={() => setShowApprovedPreview(false)}
                    request={request}
                />
            )}
            <div className="max-w-[1400px] mx-auto p-4 sm:p-6 lg:p-8 space-y-6">

                {/* Priority Alert Banner */}
                {(isCritical || isHighPriority) && (
                    <div
                        className={`relative rounded-2xl border-2 p-4 flex items-center gap-4 ${
                            isCritical 
                                ? 'bg-red-50 border-red-300' 
                                : 'bg-orange-50 border-orange-300'
                        }`}
                        style={{
                            animation: isCritical 
                                ? `pulse-red-header ${CRITICAL_ANIMATION_DURATION}s ease-in-out infinite`
                                : `pulse-orange-header ${HIGH_ANIMATION_DURATION}s ease-in-out infinite`
                        }}
                    >
                        <div className="w-16 h-16 flex-shrink-0">
                            <Lottie
                                animationData={isCritical ? criticalAnimation : urgentAnimation}
                                loop={true}
                                className="w-full h-full"
                            />
                        </div>
                        <div className="flex-1">
                            <h3 className={`text-lg font-bold ${isCritical ? 'text-red-700' : 'text-orange-700'}`}>
                                {isCritical ? 'Critical Priority Request' : 'High Priority Request'}
                            </h3>
                            <p className={`text-sm ${isCritical ? 'text-red-600' : 'text-orange-600'}`}>
                                {isCritical 
                                    ? 'This request requires immediate attention and action.'
                                    : 'This request has been marked as high priority and needs urgent review.'
                                }
                            </p>
                        </div>
                        <div className={`px-4 py-2 rounded-xl font-bold text-sm ${
                            isCritical 
                                ? 'bg-red-100 text-red-700 border border-red-200' 
                                : 'bg-orange-100 text-orange-700 border border-orange-200'
                        }`}>
                            {isCritical ? 'CRITICAL' : 'HIGH PRIORITY'}
                        </div>
                    </div>
                )}

                {/* Screening (gatekeeping assistant) — Forward / Return actions */}
                {screening && (
                    <Card className="!p-5 border-[#C9B896] bg-[#F3EADC]/50">
                        <div className="flex items-start gap-4">
                            <div className="w-10 h-10 rounded-lg bg-[#9A7545]/15 text-[#5E4426] flex items-center justify-center flex-shrink-0">
                                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                                </svg>
                            </div>
                            <div className="flex-1 min-w-0">
                                <h3 className="text-sm font-semibold text-[#5E4426]">
                                    Screen this request{screening.bossName ? ` for ${screening.bossName}` : ''}
                                </h3>
                                <p className="text-sm text-[#5E4426]/80 mt-0.5">
                                    Review it before it reaches {screening.bossName || 'the approver'}. Forward it on for
                                    approval, or return it to the requestor with a comment for changes.
                                </p>
                                {screenError && (
                                    <p className="text-sm text-red-600 font-medium mt-2">{screenError}</p>
                                )}
                                <div className="flex flex-wrap gap-3 mt-3">
                                    <Button
                                        variant="primary"
                                        onClick={handleScreenForward}
                                        disabled={screenBusy}
                                    >
                                        {screenBusy ? 'Working…' : `Forward${screening.bossName ? ` to ${screening.bossName.split(' ')[0]}` : ''}`}
                                    </Button>
                                    <Button
                                        variant="outline"
                                        onClick={() => { setScreenError(null); setShowScreenReturn(true); }}
                                        disabled={screenBusy}
                                        className="bg-white"
                                    >
                                        Return to requestor
                                    </Button>
                                </div>
                            </div>
                        </div>
                    </Card>
                )}

                {/* Publish Error Alert */}
                {publishError && (
                    <Card className="bg-danger-50 border-danger-200 !p-4">
                        <div className="flex items-center gap-3">
                            <svg className="w-5 h-5 text-danger-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                            </svg>
                            <p className="text-danger-700 text-sm">{publishError}</p>
                            <button
                                onClick={() => setPublishError(null)}
                                className="ml-auto text-danger-500 hover:text-danger-700"
                            >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" />
                                </svg>
                            </button>
                        </div>
                    </Card>
                )}

                {/* Price Variation banner — this request IS a variation: link back to the parent CAPEX. */}
                {isPriceVariationRequest && request.metadata?.parentRequestId && (
                    <Card className="bg-amber-50 border-amber-200 !p-4">
                        <div className="flex items-center gap-3">
                            <svg className="w-5 h-5 text-amber-600 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
                            </svg>
                            <p className="text-amber-800 text-sm">
                                This is a price variation raised against a CAPEX request.
                            </p>
                            <Link
                                href={`/requests/${request.metadata.parentRequestId}`}
                                className="ml-auto text-amber-700 font-medium text-sm hover:underline"
                            >
                                View CAPEX →
                            </Link>
                        </div>
                    </Card>
                )}

                {/* Pricing Variation banner — this CAPEX has one or more approved variations. */}
                {priceVariations.length > 0 && (
                    <Card className="bg-amber-50 border-amber-200 !p-4">
                        <div className="flex items-start gap-3">
                            <svg className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01M5.07 19h13.86c1.54 0 2.5-1.67 1.73-3L13.73 4a2 2 0 00-3.46 0L3.34 16c-.77 1.33.19 3 1.73 3z" />
                            </svg>
                            <div className="flex-1">
                                <p className="text-amber-800 text-sm font-semibold mb-1">
                                    Pricing Variation{priceVariations.length > 1 ? 's' : ''} recorded
                                </p>
                                <ul className="space-y-1">
                                    {priceVariations.map((v: any, i: number) => (
                                        <li key={v.id || i} className="text-sm text-amber-800 flex items-center gap-2 flex-wrap">
                                            <span>
                                                {v.supplierName ? `${v.supplierName} — ` : ''}
                                                Amount: {v.amount || '—'}
                                                {v.variance ? ` (variance ${v.variance})` : ''}
                                            </span>
                                            {v.id && (
                                                <Link href={`/requests/${v.id}`} className="text-amber-700 font-medium hover:underline">
                                                    View variation →
                                                </Link>
                                            )}
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        </div>
                    </Card>
                )}

                {/* Top Navigation Breadcrumb — send the viewer back where they came
                    from: approvers to their Approval Tasks, the requester (and
                    everyone else) to My Requests. */}
                <nav className="flex items-center text-sm text-text-secondary mb-2">
                    <Link
                        href={isApprover && !isCreator ? '/approvals' : '/requests/my-requests'}
                        className="hover:text-primary-600 transition-colors flex items-center gap-1"
                    >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
                        </svg>
                        {isApprover && !isCreator ? 'Back to Approval Tasks' : 'Back to My Requests'}
                    </Link>
                    <span className="mx-2 text-gray-300">/</span>
                    <span className="text-text-primary font-medium truncate max-w-xs">{request.title}</span>
                </nav>

                {/* Petty Cash Follow-up CTA — fully-approved travel auth, requester only, no existing link */}
                {(() => {
                    const requestType = request.metadata?.type || request.metadata?.requestType;
                    const isTravelAuth = requestType === 'travel_authorization' || requestType === 'international_travel_authorization';
                    const fullyApproved = (actualStatus || request.status) === 'approved';
                    const linkedPettyCashId = request.metadata?.linkedPettyCashId as string | undefined;
                    if (!isCreator || !isTravelAuth || !fullyApproved) return null;

                    if (linkedPettyCashId) {
                        return (
                            <div className="rounded-2xl border-2 border-emerald-200 bg-emerald-50 p-4 flex items-center gap-3">
                                <svg className="w-5 h-5 text-emerald-600 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 13l4 4L19 7" />
                                </svg>
                                <div className="flex-1 min-w-0">
                                    <p className="text-sm font-semibold text-emerald-900">Petty cash voucher already submitted for this trip.</p>
                                </div>
                                <Link
                                    href={`/requests/${linkedPettyCashId}`}
                                    className="px-4 py-2 rounded-xl bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 transition-colors flex-shrink-0"
                                >
                                    View Petty Cash
                                </Link>
                            </div>
                        );
                    }

                    return (
                        <div className="rounded-2xl border-2 border-[#C9B896] bg-gradient-to-r from-[#F3EADC] to-[#F7F0E2] p-5 flex flex-col sm:flex-row items-start sm:items-center gap-4">
                            <div className="w-12 h-12 rounded-xl bg-white border border-[#C9B896] flex items-center justify-center flex-shrink-0">
                                <svg className="w-6 h-6 text-[#9A7545]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                                </svg>
                            </div>
                            <div className="flex-1 min-w-0">
                                <h3 className="text-base font-bold text-[#3F2D19]">Travel authorization fully approved</h3>
                                <p className="text-sm text-[#5E4426] mt-1">
                                    Would you like to process the petty cash voucher for this trip? You can come back to this any time.
                                </p>
                            </div>
                            <Link
                                href={`/requests/new/petty-cash?linkedTo=${request.id}`}
                                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-[#9A7545] text-white text-sm font-semibold hover:bg-[#7C5A33] transition-colors flex-shrink-0"
                            >
                                Process Petty Cash
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
                                </svg>
                            </Link>
                        </div>
                    );
                })()}

                {/* Petty Cash cash-receipt OTP sign-off — fully-approved petty cash only */}
                <CashReceiptConfirmation
                    requestId={request.id}
                    isCreator={isCreator}
                    approved={(actualStatus || request.status) === 'approved'}
                />

                {/* Header Section */}
                <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-6">
                    <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-3 mb-3">
                            <span className={`px-3 py-1 rounded-full text-sm font-semibold flex items-center gap-1.5 ${statusInfo.bg} ${statusInfo.text}`}>
                                <div className="w-2 h-2 rounded-full bg-current" />
                                {statusInfo.label}
                            </span>
                            <span className="text-text-secondary text-sm">#{request.id.substring(0, 8)}</span>
                            {request.metadata?.referenceCode ? (
                                <span className="font-mono text-xs font-semibold text-gray-600 bg-gray-100 px-2.5 py-1 rounded border border-gray-200 tracking-wider">
                                    {request.metadata.referenceCode}
                                </span>
                            ) : null}
                        </div>

                        <h1 className="text-3xl font-bold text-text-primary font-heading leading-tight mb-2">
                            {isEditing && editedRequest ? (
                                <Input
                                    value={editedRequest.title}
                                    onChange={(e) => setEditedRequest({ ...editedRequest, title: e.target.value })}
                                    className="!text-2xl !font-bold !py-3"
                                    placeholder="Request Title"
                                />
                            ) : (
                                request.title
                            )}
                        </h1>
                        {/* Show guest name or identifier if available */}
                        {request.metadata?.guestNames && (
                            <p className="text-primary-600 font-medium text-lg mt-1">
                                {request.metadata.guestNames}
                            </p>
                        )}
                        {!request.metadata?.guestNames && (request.metadata?.guestTitle || request.metadata?.guestFirstName) && (
                            <p className="text-primary-600 font-medium text-lg mt-1">
                                {request.metadata.guestTitle} {request.metadata.guestFirstName}
                            </p>
                        )}
                        <div className="text-text-secondary text-lg leading-relaxed max-w-3xl">
                            {isEditing && editedRequest ? (
                                <textarea
                                    value={editedRequest.description}
                                    onChange={(e) => setEditedRequest({ ...editedRequest, description: e.target.value })}
                                    className="w-full px-4 py-3 rounded-xl border border-gray-300 bg-white text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent min-h-[100px]"
                                    placeholder="Description"
                                />
                            ) : (
                                request.description
                            )}
                        </div>
                    </div>

                    <div className="flex gap-3 flex-shrink-0">
                        {/* Delete button for creator's non-approved requests */}
                        {canDelete && (
                            <Button
                                variant="outline"
                                className="gap-2 bg-white text-danger-600 border-danger-200 hover:bg-danger-50"
                                onClick={() => setShowDeleteConfirm(true)}
                            >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                </svg>
                                Delete
                            </Button>
                        )}
                        {/* Preview — always available so the requester (and watchers/approvers)
                            can see the form-style document at any status. Uses the same
                            RequestPreviewModal layout as the form submission preview. */}
                        <Button
                            variant="outline"
                            className="gap-2 bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100"
                            onClick={() => setShowApprovedPreview(true)}
                        >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                            </svg>
                            Preview
                        </Button>
                        {/* Price Variation: only for the creator of a fully-approved CAPEX. */}
                        {canRaisePriceVariation && (
                            <Button
                                variant="outline"
                                className="gap-2 bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100"
                                onClick={() => router.push(`/requests/new/price-variation?parent=${request.id}`)}
                            >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
                                </svg>
                                Raise Price Variation
                            </Button>
                        )}
                        {/* Inter-Unit Debit Note: dedicated paper-format printable view. */}
                        {(request.metadata?.type === 'inter_unit_debit_note' || request.metadata?.requestType === 'inter_unit_debit_note') && (
                            <Button
                                variant="outline"
                                className="gap-2 bg-white text-[#5E4426] border-[#C9B896] hover:bg-[#F3EADC]"
                                onClick={() => window.open(`/api/requests/${id}/debit-note-pdf`, '_blank')}
                            >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
                                </svg>
                                Print Debit Note
                            </Button>
                        )}
                        {/* Inter-Unit Credit Note: dedicated paper-format printable view. */}
                        {(request.metadata?.type === 'inter_unit_credit_note' || request.metadata?.requestType === 'inter_unit_credit_note') && (
                            <Button
                                variant="outline"
                                className="gap-2 bg-white text-[#5E4426] border-[#C9B896] hover:bg-[#F3EADC]"
                                onClick={() => window.open(`/api/requests/${id}/credit-note-pdf`, '_blank')}
                            >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
                                </svg>
                                Print Credit Note
                            </Button>
                        )}
                        {/* Download — only visible once fully approved. Uses primary variant
                            with explicit emerald colours so the white-on-emerald text stays
                            readable on hover (the previous outline variant ate the bg). */}
                        {request.status === 'approved' && (
                            <Button
                                variant="primary"
                                style={{ backgroundColor: '#059669', borderColor: '#059669', color: '#ffffff' }}
                                className="gap-2 hover:!bg-emerald-700 disabled:opacity-60"
                                onClick={() => printApprovedRequest(request)}
                            >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 10v6m0 0l-3-3m3 3l3-3M3 17V7a2 2 0 012-2h6l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
                                </svg>
                                <span style={{ color: '#ffffff' }}>Download</span>
                            </Button>
                        )}
                        {/* Microsoft 365 copies — appear once the approved PDF has been
                            auto-archived to the requester's OneDrive / the organisation's
                            SharePoint library. */}
                        {request.status === 'approved' && archiveLinks?.onedrive && (
                            <Button
                                variant="outline"
                                className="gap-2 bg-white text-[#0364B8] border-[#B3D4EE] hover:bg-[#EFF6FC]"
                                onClick={() => window.open(archiveLinks.onedrive, '_blank', 'noopener,noreferrer')}
                            >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z" />
                                </svg>
                                Open in OneDrive
                            </Button>
                        )}
                        {request.status === 'approved' && archiveLinks?.sharepoint && (
                            <Button
                                variant="outline"
                                className="gap-2 bg-white text-[#036C70] border-[#A5D2D4] hover:bg-[#EBF5F5]"
                                onClick={() => window.open(archiveLinks.sharepoint, '_blank', 'noopener,noreferrer')}
                            >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z" />
                                </svg>
                                Open in SharePoint
                            </Button>
                        )}
                        {/* Edit Draft button - navigates to the form page */}
                        {canPublish && (
                            <Button
                                variant="secondary"
                                className="gap-2 border border-primary-200 bg-primary-50 text-primary-700 hover:bg-primary-100"
                                onClick={() => {
                                    // Map request type to route (underscores to hyphens)
                                    const requestType = request.metadata?.type || request.metadata?.requestType || 'capex';
                                    const routeMap: Record<string, string> = {
                                        'hotel_booking': 'hotel-booking',
                                        'travel_authorization': 'travel-auth',
                                        'external_hotel_booking': 'external-hotel-booking',
                                        'inter_unit_debit_note': 'inter-unit-debit-note',
                                        'inter_unit_credit_note': 'inter-unit-credit-note',
                                    };
                                    const route = routeMap[requestType] || requestType;
                                    router.push(`/requests/new/${route}?edit=${id}`);
                                }}
                            >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                                </svg>
                                Edit Draft
                            </Button>
                        )}
                        {/* Publish button for draft requests */}
                        {canPublish && (
                            <Button
                                variant="primary"
                                className="gap-2 shadow-lg shadow-primary-500/20"
                                onClick={handlePublish}
                                disabled={publishing}
                                isLoading={publishing}
                            >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                                </svg>
                                {publishing ? 'Publishing...' : 'Publish Request'}
                            </Button>
                        )}
                        {/* Review button for current approver */}
                        {isCurrentApprover && (
                            <Button
                                variant="primary"
                                className="gap-2 shadow-lg shadow-primary-500/20"
                                onClick={() => setShowReviewModal(true)}
                            >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                                </svg>
                                Review Request
                            </Button>
                        )}
                        {/* Edit & Resubmit — only for the creator of a rejected request */}
                        {canResubmit && !isResubmitting && (
                            <Button
                                variant="primary"
                                className="gap-2 shadow-lg shadow-primary-500/20"
                                onClick={beginResubmit}
                            >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                                </svg>
                                Edit &amp; Resubmit
                            </Button>
                        )}
                        {/* Resubmission edit mode: cancel / submit */}
                        {isResubmitting && (
                            <>
                                <Button
                                    variant="outline"
                                    className="gap-2 bg-white text-text-secondary border-gray-200 hover:bg-gray-50"
                                    onClick={cancelResubmit}
                                    disabled={submittingResubmit}
                                >
                                    Cancel
                                </Button>
                                <Button
                                    variant="primary"
                                    className="gap-2 shadow-lg shadow-primary-500/20"
                                    onClick={handleResubmit}
                                    disabled={submittingResubmit}
                                    isLoading={submittingResubmit}
                                >
                                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                                    </svg>
                                    {submittingResubmit ? 'Resubmitting…' : 'Submit Resubmission'}
                                </Button>
                            </>
                        )}
                        {/* Unsubmit & Edit — creator only, while pending and no approver has acted */}
                        {canUnsubmit && !isResubmitting && (
                            <Button
                                variant="outline"
                                className="gap-2 bg-white text-text-secondary border-gray-200 hover:bg-gray-50"
                                onClick={handleUnsubmit}
                                disabled={unsubmitting}
                                isLoading={unsubmitting}
                            >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                                </svg>
                                {unsubmitting ? 'Unsubmitting…' : 'Unsubmit & Edit'}
                            </Button>
                        )}
                        {/* Reopen & Edit — creator only, revive a cancelled request */}
                        {canRevive && !isResubmitting && (
                            <Button
                                variant="outline"
                                className="gap-2 bg-white text-primary-700 border-primary-200 hover:bg-primary-50"
                                onClick={handleUnsubmit}
                                disabled={unsubmitting}
                                isLoading={unsubmitting}
                            >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                                </svg>
                                {unsubmitting ? 'Reopening…' : 'Reopen & Edit'}
                            </Button>
                        )}
                        {/* Cancel Request — requester or approver, at any stage (incl. approved) */}
                        {canCancel && !isResubmitting && (
                            <Button
                                variant="outline"
                                className="gap-2 bg-white text-danger-600 border-danger-200 hover:bg-danger-50"
                                onClick={() => { setCancelReason(''); setShowCancelModal(true); }}
                            >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                                </svg>
                                Cancel Request
                            </Button>
                        )}
                    </div>
                </div>

                {/* Rejection banner — shown to the requester on a rejected request so the
                    reason is front-and-centre alongside the resubmit affordance. */}
                {canResubmit && (
                    <Card className="!p-5 border-rose-200 bg-rose-50/50 shadow-sm">
                        <div className="flex items-start gap-3">
                            <div className="w-10 h-10 rounded-full bg-rose-100 flex items-center justify-center flex-shrink-0">
                                <svg className="w-5 h-5 text-rose-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" />
                                </svg>
                            </div>
                            <div className="flex-1 min-w-0">
                                <p className="font-semibold text-rose-800">
                                    This request was rejected{rejectedStepInfo?.approverName ? ` by ${rejectedStepInfo.approverName}` : ''}
                                    {rejectedStepInfo?.signedAt ? ` on ${formatDateTime(rejectedStepInfo.signedAt)}` : ''}.
                                </p>
                                {rejectedStepInfo?.comment ? (
                                    <div className="mt-2 bg-white rounded-lg p-3 text-sm text-gray-700 border border-rose-100">
                                        <span className="text-xs font-semibold text-rose-700 uppercase tracking-wide">Rejection reason</span>
                                        <p className="italic mt-1">&ldquo;{rejectedStepInfo.comment}&rdquo;</p>
                                    </div>
                                ) : (
                                    <p className="text-sm text-rose-600 mt-1">No reason was provided.</p>
                                )}
                                <p className="text-sm text-rose-700 mt-2">
                                    {isResubmitting
                                        ? 'Edit the fields below to address the feedback, then choose “Submit Resubmission”. A new versioned reference will be generated and your approvers re-notified.'
                                        : 'Use “Edit & Resubmit” to address the feedback and send it back through the approval chain.'}
                                </p>
                            </div>
                        </div>
                    </Card>
                )}

                {/* Cancellation banner — shown once a request has been cancelled. */}
                {(actualStatus || request.status) === 'cancelled' && cancellationInfo && (
                    <Card className="!p-5 border-gray-300 bg-gray-50 shadow-sm">
                        <div className="flex items-start gap-3">
                            <div className="w-10 h-10 rounded-full bg-gray-200 flex items-center justify-center flex-shrink-0">
                                <svg className="w-5 h-5 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                                </svg>
                            </div>
                            <div className="flex-1 min-w-0">
                                <p className="font-semibold text-gray-800">
                                    This request was cancelled
                                    {cancellationInfo.cancelledByName ? ` by ${cancellationInfo.cancelledByName}` : ''}
                                    {cancellationInfo.cancelledByKind ? ` (${cancellationInfo.cancelledByKind})` : ''}
                                    {cancellationInfo.cancelledAt ? ` on ${formatDateTime(cancellationInfo.cancelledAt)}` : ''}.
                                </p>
                                {cancellationInfo.previousStatus && (
                                    <p className="text-sm text-gray-500 mt-0.5">
                                        Cancelled from status: <span className="font-medium">{cancellationInfo.previousStatus}</span>
                                    </p>
                                )}
                                {cancellationInfo.reason && (
                                    <div className="mt-2 bg-white rounded-lg p-3 text-sm text-gray-700 border border-gray-200">
                                        <span className="text-xs font-semibold text-gray-600 uppercase tracking-wide">Cancellation reason</span>
                                        <p className="italic mt-1">&ldquo;{cancellationInfo.reason}&rdquo;</p>
                                    </div>
                                )}
                            </div>
                        </div>
                    </Card>
                )}

                {/* Main Content Grid */}
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">

                    {/* Left Column: Details & Content */}
                    <div className="lg:col-span-2 space-y-6">

                        {/* Tabs */}
                        <div className="border-b border-gray-200">
                            <div className="flex gap-8">
                                {(['preview', 'details', 'timeline', 'documents'] as const).map((tab) => (
                                    <button
                                        key={tab}
                                        onClick={() => setActiveTab(tab)}
                                        className={`
                      pb-4 px-1 text-sm font-medium border-b-2 transition-all capitalize
                      ${activeTab === tab
                                                ? 'border-primary-500 text-primary-600'
                                                : 'border-transparent text-text-secondary hover:text-text-primary hover:border-gray-300'}
                    `}
                                    >
                                        {tab}
                                    </button>
                                ))}
                            </div>
                        </div>

                        <div className="min-h-[400px]">
                            {activeTab === 'preview' && (
                                <ApprovedRequestPreviewInline request={request} />
                            )}
                            {activeTab === 'details' && (
                                <div className="space-y-6">
                                    {/* Approver Editing Notice */}
                                    {isApproverEditing && (
                                        <Card className="!p-4 border-primary-200 bg-primary-50/50 shadow-sm">
                                            <div className="flex items-center gap-3">
                                                <div className="w-10 h-10 rounded-full bg-primary-100 flex items-center justify-center flex-shrink-0">
                                                    <svg className="w-5 h-5 text-primary-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                                                    </svg>
                                                </div>
                                                <div>
                                                    <p className="font-semibold text-primary-800">Editing as Approver</p>
                                                    <p className="text-sm text-primary-600">Your changes will be tracked and visible to the requester and other viewers.</p>
                                                </div>
                                            </div>
                                        </Card>
                                    )}

                                    {/* Watcher View Notice */}
                                    {isWatcher && !isCreator && !canApproverEdit && (
                                        <Card className="!p-4 border-gray-200 bg-gray-50 shadow-sm">
                                            <div className="flex items-center gap-3 text-gray-500">
                                                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                                                </svg>
                                                <div>
                                                    <p className="font-medium text-gray-600">Viewing as Watcher</p>
                                                    <p className="text-sm">You can track this request but cannot make changes.</p>
                                                </div>
                                            </div>
                                        </Card>
                                    )}

                                    {/* Resubmission edit mode: editable form fields for the requester */}
                                    {isResubmitting && editedRequest ? (
                                        <Card className="!p-6 border-primary-200 bg-primary-50/30 shadow-sm">
                                            <div className="flex items-center gap-2 mb-4">
                                                <svg className="w-5 h-5 text-primary-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                                                </svg>
                                                <h3 className="font-semibold text-primary-800">Edit request fields</h3>
                                            </div>
                                            <ResubmitFieldsEditor
                                                metadata={editedRequest.metadata}
                                                onChange={handleMetadataChange}
                                            />
                                        </Card>
                                    ) : (
                                        /* Dynamic Form Details - renders all form fields based on configuration */
                                        <DynamicFormDetails
                                            metadata={request.metadata || {}}
                                            requestType={request.metadata?.type || 'approval'}
                                            description={request.description}
                                        />
                                    )}
                                </div>
                            )}

                            {activeTab === 'timeline' && (
                                <div className="space-y-6">
                                    {/* Prior rejected rounds (original submission → rejection history) */}
                                    <ResubmissionHistoryCard history={request.metadata?.resubmissionHistory} />

                                    <ApprovalTimeline
                                        request={isEditing && editedRequest ? editedRequest : request}
                                        isEditing={isEditing && canPublish}
                                        onApproversChange={(approverIds) => {
                                            if (editedRequest) {
                                                setEditedRequest({
                                                    ...editedRequest,
                                                    metadata: {
                                                        ...editedRequest.metadata,
                                                        approvers: approverIds,
                                                    },
                                                });
                                            }
                                        }}
                                    />

                                    {/* Modifications History Section */}
                                    {modifications.length > 0 && (
                                        <Card className="!p-0 overflow-hidden border-amber-100 shadow-sm">
                                            <div className="bg-amber-50/50 px-6 py-4 border-b border-amber-100 flex items-center justify-between">
                                                <h3 className="font-semibold text-amber-800 flex items-center gap-2">
                                                    <svg className="w-5 h-5 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                                                    </svg>
                                                    Modification History
                                                </h3>
                                                <span className="text-sm text-amber-600 font-medium">{modifications.length} change{modifications.length !== 1 ? 's' : ''}</span>
                                            </div>
                                            <div className="p-4 space-y-3 max-h-96 overflow-y-auto">
                                                {modifications.map((mod: any) => (
                                                    <div key={mod.id} className="flex items-start gap-3 p-3 bg-white rounded-xl border border-gray-100 hover:border-gray-200 transition-colors">
                                                        <img
                                                            src={mod.modified_by?.profile_picture_url || `https://ui-avatars.com/api/?name=${encodeURIComponent(mod.modified_by?.display_name || 'User')}&background=random&size=32`}
                                                            alt={mod.modified_by?.display_name || 'User'}
                                                            className="w-8 h-8 rounded-full object-cover border border-white shadow-sm flex-shrink-0"
                                                        />
                                                        <div className="flex-1 min-w-0">
                                                            <div className="flex items-center gap-2 flex-wrap">
                                                                <span className="font-semibold text-gray-900 text-sm">{mod.modified_by?.display_name || 'Unknown User'}</span>
                                                                <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                                                                    mod.modification_type === 'field_edit'
                                                                        ? 'bg-[#F3EADC] text-[#5E4426]'
                                                                        : mod.modification_type === 'document_upload'
                                                                            ? 'bg-green-100 text-green-700'
                                                                            : mod.modification_type === 'resubmission'
                                                                                ? 'bg-blue-100 text-blue-700'
                                                                                : mod.modification_type === 'cancellation'
                                                                                    ? 'bg-gray-200 text-gray-700'
                                                                                    : 'bg-red-100 text-red-700'
                                                                }`}>
                                                                    {mod.modification_type === 'field_edit' && 'Edited Field'}
                                                                    {mod.modification_type === 'document_upload' && 'Uploaded Document'}
                                                                    {mod.modification_type === 'document_delete' && 'Deleted Document'}
                                                                    {mod.modification_type === 'resubmission' && 'Resubmitted'}
                                                                    {mod.modification_type === 'cancellation' && 'Cancelled'}
                                                                </span>
                                                            </div>
                                                            <div className="text-sm text-gray-600 mt-1">
                                                                {mod.modification_type === 'field_edit' && (
                                                                    <>
                                                                        Changed <span className="font-medium text-gray-800">{getFieldLabel(mod.field_name)}</span>
                                                                        {mod.old_value && (
                                                                            <> from <span className="text-gray-500 line-through">{formatModificationValue(mod.field_name, mod.old_value)}</span></>
                                                                        )}
                                                                        {mod.new_value && (
                                                                            <> to <span className="font-medium text-gray-800">{formatModificationValue(mod.field_name, mod.new_value)}</span></>
                                                                        )}
                                                                    </>
                                                                )}
                                                                {mod.modification_type === 'document_upload' && (
                                                                    <>Uploaded <span className="font-medium text-gray-800">{mod.document_filename}</span></>
                                                                )}
                                                                {mod.modification_type === 'document_delete' && (
                                                                    <>Deleted <span className="font-medium text-gray-800">{mod.document_filename}</span></>
                                                                )}
                                                                {mod.modification_type === 'resubmission' && (
                                                                    <>
                                                                        Resubmitted the request
                                                                        {mod.new_value && (
                                                                            <> as <span className="font-medium text-gray-800">{mod.new_value}</span></>
                                                                        )}
                                                                    </>
                                                                )}
                                                                {mod.modification_type === 'cancellation' && (
                                                                    <>
                                                                        Cancelled the request
                                                                        {mod.new_value && (
                                                                            <>: <span className="italic text-gray-700">&ldquo;{mod.new_value}&rdquo;</span></>
                                                                        )}
                                                                    </>
                                                                )}
                                                            </div>
                                                            <div className="text-xs text-gray-400 mt-1">
                                                                {formatDateTime(mod.created_at)}
                                                            </div>
                                                        </div>
                                                    </div>
                                                ))}
                                            </div>
                                        </Card>
                                    )}

                                    {/* Watchers Section */}
                                    <WatchersCard watcherData={request.metadata?.watchers} />
                                </div>
                            )}

                            {activeTab === 'documents' && (() => {
                                // Get quotations and supporting documents from metadata
                                const quotations = Array.isArray(request.metadata?.quotations) ? request.metadata.quotations : [];
                                const supportingDocs = Array.isArray(request.metadata?.supportingDocuments) ? request.metadata.supportingDocuments : [];
                                
                                // Get additional documents uploaded directly (not in metadata)
                                const metadataFilenames = [
                                    ...quotations.map((q: any) => q.name),
                                    ...supportingDocs.map((d: any) => d.name)
                                ];
                                const additionalDocuments = documents.filter(doc => !metadataFilenames.includes(doc.filename));
                                
                                const hasDocuments = quotations.length > 0 || supportingDocs.length > 0 || additionalDocuments.length > 0;

                                // Helper to find matching uploaded document by filename
                                const findUploadedDocument = (filename: string) => {
                                    return documents.find(doc => doc.filename === filename);
                                };

                                // Helper to format file size
                                const formatFileSize = (bytes: number) => {
                                    if (!bytes) return 'Unknown size';
                                    if (bytes < 1024) return `${bytes} B`;
                                    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
                                    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
                                };

                                // Helper to get file icon based on type
                                const getFileIcon = (type: string) => {
                                    if (type?.includes('pdf')) return (
                                        <svg className="w-5 h-5 text-red-500" fill="currentColor" viewBox="0 0 24 24">
                                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm-1 2l5 5h-5V4zm-3 9.5c0 .28-.22.5-.5.5H8v2h1.5c.28 0 .5.22.5.5s-.22.5-.5.5H7.5a.5.5 0 0 1-.5-.5v-5a.5.5 0 0 1 .5-.5H10c.28 0 .5.22.5.5s-.22.5-.5.5H8v1.5h1.5c.28 0 .5.22.5.5zm4.5 2.5h-1v-5h1c1.1 0 2 .9 2 2v1c0 1.1-.9 2-2 2zm0-4v3c.55 0 1-.45 1-1v-1c0-.55-.45-1-1-1zm4.5 4h-2a.5.5 0 0 1-.5-.5v-5a.5.5 0 0 1 .5-.5h2c.28 0 .5.22.5.5s-.22.5-.5.5H18v1.5h1c.28 0 .5.22.5.5s-.22.5-.5.5h-1v2c.28 0 .5.22.5.5s-.22.5-.5.5z" />
                                        </svg>
                                    );
                                    if (type?.includes('image')) return (
                                        <svg className="w-5 h-5 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                                        </svg>
                                    );
                                    if (type?.includes('word') || type?.includes('doc')) return (
                                        <svg className="w-5 h-5 text-[#9A7545]" fill="currentColor" viewBox="0 0 24 24">
                                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm-1 2l5 5h-5V4zM9.5 11h5c.28 0 .5.22.5.5s-.22.5-.5.5h-5a.5.5 0 0 1-.5-.5c0-.28.22-.5.5-.5zm0 2h5c.28 0 .5.22.5.5s-.22.5-.5.5h-5a.5.5 0 0 1-.5-.5c0-.28.22-.5.5-.5zm0 2h5c.28 0 .5.22.5.5s-.22.5-.5.5h-5a.5.5 0 0 1-.5-.5c0-.28.22-.5.5-.5z" />
                                        </svg>
                                    );
                                    return (
                                        <svg className="w-5 h-5 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                                        </svg>
                                    );
                                };

                                // Helper to handle document view/download
                                const handleViewDocument = (doc: any) => {
                                    if (doc.download_url) {
                                        window.open(doc.download_url, '_blank');
                                    }
                                };

                                if (loadingDocuments) {
                                    return (
                                        <Card className="!p-8 border-gray-200 shadow-sm">
                                            <div className="flex items-center justify-center py-8">
                                                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-500"></div>
                                                <span className="ml-3 text-gray-500">Loading documents...</span>
                                            </div>
                                        </Card>
                                    );
                                }

                                return (
                                    <div className="space-y-6">
                                        {/* Upload Section - Show for creator or approver (not watchers) */}
                                        {canUploadDoc && (
                                            <Card className={`!p-4 shadow-sm ${canApproverEdit ? 'border-primary-200 bg-primary-50/30' : 'border-gray-200'}`}>
                                                <div className="flex items-center justify-between">
                                                    <div>
                                                        <h4 className="font-medium text-text-primary flex items-center gap-2">
                                                            Upload Documents
                                                            {canApproverEdit && (
                                                                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-primary-100 text-primary-700">
                                                                    Approver
                                                                </span>
                                                            )}
                                                        </h4>
                                                        <p className="text-sm text-text-secondary">
                                                            {canApproverEdit
                                                                ? 'Upload additional documents as part of your review'
                                                                : 'Add supporting files to this request'}
                                                        </p>
                                                    </div>
                                                    <label className="cursor-pointer">
                                                        <input
                                                            type="file"
                                                            className="hidden"
                                                            accept=".pdf,.doc,.docx,.xls,.xlsx,.jpg,.jpeg,.png"
                                                            onChange={handleFileSelect}
                                                            disabled={uploadingDocument || uploadingApproverDocument}
                                                        />
                                                        <Button
                                                            variant="primary"
                                                            className="gap-2"
                                                            disabled={uploadingDocument || uploadingApproverDocument}
                                                            isLoading={uploadingDocument || uploadingApproverDocument}
                                                            onClick={(e) => {
                                                                e.preventDefault();
                                                                (e.currentTarget.previousElementSibling as HTMLInputElement)?.click();
                                                            }}
                                                        >
                                                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                                                            </svg>
                                                            {(uploadingDocument || uploadingApproverDocument) ? 'Uploading...' : 'Upload File'}
                                                        </Button>
                                                    </label>
                                                </div>
                                            </Card>
                                        )}

                                        {/* Read-only viewers (e.g. permanent watchers) can't upload. */}
                                        {!canUploadDoc && (
                                            <Card className="!p-4 border-gray-200 shadow-sm bg-gray-50">
                                                <div className="flex items-center gap-3 text-gray-500">
                                                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                                                    </svg>
                                                    <div>
                                                        <p className="font-medium text-gray-600">Read-only view</p>
                                                        <p className="text-sm">You can view documents but cannot upload or modify them.</p>
                                                    </div>
                                                </div>
                                            </Card>
                                        )}

                                        {/* Quotations Section */}
                                        {quotations.length > 0 && (
                                            <Card className="!p-0 overflow-hidden border-gray-200 shadow-sm">
                                                <div className="bg-emerald-50/50 px-6 py-4 border-b border-emerald-100 flex items-center justify-between">
                                                    <h3 className="font-semibold text-emerald-800 flex items-center gap-2">
                                                        <svg className="w-5 h-5 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                                                        </svg>
                                                        Quotations
                                                    </h3>
                                                    <span className="text-sm text-emerald-600 font-medium">{quotations.length} uploaded</span>
                                                </div>
                                                <div className="p-4 space-y-3">
                                                    {quotations.map((quotation: any, index: number) => {
                                                        const uploadedDoc = findUploadedDocument(quotation.name);
                                                        const downloadUrl = uploadedDoc?.download_url;
                                                        
                                                        return (
                                                            <div key={index} className={`p-4 rounded-xl border transition-all ${quotation.isSelectedSupplier ? 'bg-emerald-50 border-emerald-200 ring-1 ring-emerald-100' : 'bg-white border-gray-200 hover:border-gray-300'}`}>
                                                                <div className="flex items-start justify-between gap-4">
                                                                    <div className="flex items-start gap-3 flex-1">
                                                                        <div className={`w-12 h-12 rounded-lg flex items-center justify-center flex-shrink-0 ${quotation.isSelectedSupplier ? 'bg-emerald-100' : 'bg-gray-100'}`}>
                                                                            <svg className={`w-6 h-6 ${quotation.isSelectedSupplier ? 'text-emerald-600' : 'text-gray-500'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                                                                            </svg>
                                                                        </div>
                                                                        <div className="flex-1 min-w-0">
                                                                            <div className="flex items-center gap-2 flex-wrap">
                                                                                <p className="font-semibold text-gray-900">{quotation.name}</p>
                                                                                {quotation.isSelectedSupplier && (
                                                                                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-700">
                                                                                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 13l4 4L19 7" />
                                                                                        </svg>
                                                                                        Selected Supplier
                                                                                    </span>
                                                                                )}
                                                                            </div>
                                                                            <p className="text-xs text-gray-500 mt-0.5">{formatFileSize(quotation.size)}</p>
                                                                            {quotation.uploadedBy && (
                                                                                <p className="text-xs text-gray-400 mt-1 flex items-center gap-1">
                                                                                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                                                                                    </svg>
                                                                                    Uploaded by {quotation.uploadedBy.name}
                                                                                    {quotation.uploadedBy.isApprover && (
                                                                                        <span className="ml-1 px-1.5 py-0.5 rounded text-xs bg-primary-100 text-primary-700">Approver</span>
                                                                                    )}
                                                                                    {quotation.uploadedAt && (
                                                                                        <span className="ml-1">• {new Date(quotation.uploadedAt).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' })}</span>
                                                                                    )}
                                                                                </p>
                                                                            )}
                                                                            {quotation.supplierName && (
                                                                                <p className="text-sm text-gray-600 mt-2">
                                                                                    <span className="font-medium">Supplier:</span> {quotation.supplierName}
                                                                                </p>
                                                                            )}
                                                                            {quotation.description && (
                                                                                <p className="text-sm text-gray-500 mt-1">{quotation.description}</p>
                                                                            )}
                                                                            {quotation.isSelectedSupplier && quotation.selectionReason && (
                                                                                <div className="mt-3 p-3 bg-white rounded-lg border border-emerald-100">
                                                                                    <p className="text-xs font-semibold text-emerald-600 uppercase tracking-wider mb-1">Selection Reason</p>
                                                                                    <p className="text-sm text-gray-700">{quotation.selectionReason}</p>
                                                                                </div>
                                                                            )}
                                                                        </div>
                                                                    </div>
                                                                    <div className="flex items-center gap-2 flex-shrink-0">
                                                                        {downloadUrl && (
                                                                            <>
                                                                                <Button
                                                                                    variant="outline"
                                                                                    size="sm"
                                                                                    className="bg-white"
                                                                                    onClick={() => window.open(downloadUrl, '_blank', 'noopener,noreferrer')}
                                                                                >
                                                                                    <svg className="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                                                                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                                                                                    </svg>
                                                                                    View
                                                                                </Button>
                                                                                <Button
                                                                                    variant="outline"
                                                                                    size="sm"
                                                                                    className="bg-white"
                                                                                    onClick={() => {
                                                                                        const link = document.createElement('a');
                                                                                        link.href = downloadUrl;
                                                                                        link.download = quotation.name;
                                                                                        document.body.appendChild(link);
                                                                                        link.click();
                                                                                        document.body.removeChild(link);
                                                                                    }}
                                                                                >
                                                                                    <svg className="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                                                                                    </svg>
                                                                                    Download
                                                                                </Button>
                                                                            </>
                                                                        )}
                                                                    </div>
                                                                </div>
                                                            </div>
                                                        );
                                                    })}
                                                </div>

                                                {/* Quotation Justification */}
                                                {request.metadata?.quotationJustification && (
                                                    <div className="px-4 pb-4">
                                                        <div className="p-4 bg-amber-50 rounded-xl border border-amber-200">
                                                            <div className="flex items-start gap-3">
                                                                <svg className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                                                                </svg>
                                                                <div>
                                                                    <p className="text-sm font-semibold text-amber-800">Quotation Justification</p>
                                                                    <p className="text-sm text-amber-700 mt-1">{request.metadata.quotationJustification}</p>
                                                                </div>
                                                            </div>
                                                        </div>
                                                    </div>
                                                )}
                                            </Card>
                                        )}

                                        {/* Supporting Documents Section */}
                                        {supportingDocs.length > 0 && (
                                            <Card className="!p-0 overflow-hidden border-gray-200 shadow-sm">
                                                <div className="bg-[#F3EADC]/50 px-6 py-4 border-b border-[#E6D3B3] flex items-center justify-between">
                                                    <h3 className="font-semibold text-[#3F2D19] flex items-center gap-2">
                                                        <svg className="w-5 h-5 text-[#9A7545]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                                                        </svg>
                                                        Supporting Documents
                                                    </h3>
                                                    <span className="text-sm text-[#9A7545] font-medium">{supportingDocs.length} uploaded</span>
                                                </div>
                                                <div className="p-4 space-y-3">
                                                    {supportingDocs.map((doc: any, index: number) => {
                                                        const uploadedDoc = findUploadedDocument(doc.name);
                                                        const downloadUrl = uploadedDoc?.download_url;
                                                        
                                                        return (
                                                            <div key={index} className="p-4 bg-white rounded-xl border border-gray-200 hover:border-gray-300 transition-colors">
                                                                <div className="flex items-start justify-between gap-4">
                                                                    <div className="flex items-start gap-3 flex-1 min-w-0">
                                                                        <div className="w-12 h-12 bg-[#F3EADC] rounded-lg flex items-center justify-center flex-shrink-0">
                                                                            {getFileIcon(doc.type || '')}
                                                                        </div>
                                                                        <div className="flex-1 min-w-0">
                                                                            <p className="font-semibold text-gray-900">{doc.name}</p>
                                                                            <div className="grid grid-cols-2 gap-x-4 gap-y-1 mt-2 text-xs">
                                                                                <div>
                                                                                    <span className="text-gray-500">Size:</span>
                                                                                    <span className="ml-1 text-gray-700 font-medium">{formatFileSize(doc.size)}</span>
                                                                                </div>
                                                                                <div>
                                                                                    <span className="text-gray-500">Type:</span>
                                                                                    <span className="ml-1 text-gray-700 font-medium">{doc.type || 'Unknown'}</span>
                                                                                </div>
                                                                                {doc.uploadedBy && (
                                                                                    <div className="col-span-2 flex items-center gap-1 mt-1">
                                                                                        <svg className="w-3 h-3 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                                                                                        </svg>
                                                                                        <span className="text-gray-500">Uploaded by:</span>
                                                                                        <span className="text-gray-700 font-medium">{doc.uploadedBy.name}</span>
                                                                                        {doc.uploadedBy.isApprover && (
                                                                                            <span className="px-1.5 py-0.5 rounded text-xs bg-primary-100 text-primary-700">Approver</span>
                                                                                        )}
                                                                                    </div>
                                                                                )}
                                                                                {doc.uploadedAt && (
                                                                                    <div className="col-span-2">
                                                                                        <span className="text-gray-500">Uploaded:</span>
                                                                                        <span className="ml-1 text-gray-700 font-medium">
                                                                                            {new Date(doc.uploadedAt).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' })} at {new Date(doc.uploadedAt).toLocaleTimeString('en-US', {
                                                                                                hour: '2-digit', minute: '2-digit'
                                                                                            })}
                                                                                        </span>
                                                                                    </div>
                                                                                )}
                                                                            </div>
                                                                            {doc.description && (
                                                                                <p className="text-sm text-gray-600 mt-2 p-2 bg-gray-50 rounded-lg">{doc.description}</p>
                                                                            )}
                                                                        </div>
                                                                    </div>
                                                                    <div className="flex flex-col gap-2 flex-shrink-0">
                                                                        {downloadUrl && (
                                                                            <>
                                                                                <Button
                                                                                    variant="outline"
                                                                                    size="sm"
                                                                                    className="bg-white w-full"
                                                                                    onClick={() => window.open(downloadUrl, '_blank', 'noopener,noreferrer')}
                                                                                >
                                                                                    <svg className="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                                                                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                                                                                    </svg>
                                                                                    View
                                                                                </Button>
                                                                                <Button
                                                                                    variant="outline"
                                                                                    size="sm"
                                                                                    className="bg-white w-full"
                                                                                    onClick={() => {
                                                                                        const link = document.createElement('a');
                                                                                        link.href = downloadUrl;
                                                                                        link.download = doc.name;
                                                                                        document.body.appendChild(link);
                                                                                        link.click();
                                                                                        document.body.removeChild(link);
                                                                                    }}
                                                                                >
                                                                                    <svg className="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                                                                                    </svg>
                                                                                    Download
                                                                                </Button>
                                                                            </>
                                                                        )}
                                                                    </div>
                                                                </div>
                                                            </div>
                                                        );
                                                    })}
                                                </div>
                                            </Card>
                                        )}

                                        {/* Additional Uploaded Documents Section */}
                                        {additionalDocuments.length > 0 && (
                                            <Card className="!p-0 overflow-hidden border-gray-200 shadow-sm">
                                                <div className="bg-[#F3EADC]/50 px-6 py-4 border-b border-[#E6D3B3] flex items-center justify-between">
                                                    <h3 className="font-semibold text-[#3F2D19] flex items-center gap-2">
                                                        <svg className="w-5 h-5 text-[#9A7545]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                                                        </svg>
                                                        Additional Documents
                                                    </h3>
                                                    <span className="text-sm text-[#9A7545] font-medium">{additionalDocuments.length} uploaded</span>
                                                </div>
                                                <div className="p-4 space-y-3">
                                                    {additionalDocuments.map((doc: any) => (
                                                        <div key={doc.id} className="p-4 bg-white rounded-xl border border-gray-200 hover:border-gray-300 transition-colors">
                                                            <div className="flex items-start justify-between gap-4">
                                                                <div className="flex items-start gap-3 flex-1 min-w-0">
                                                                    <div className="w-12 h-12 bg-[#F3EADC] rounded-lg flex items-center justify-center flex-shrink-0">
                                                                        {getFileIcon(doc.mime_type || '')}
                                                                    </div>
                                                                    <div className="flex-1 min-w-0">
                                                                        <div className="flex items-center gap-2 flex-wrap">
                                                                            <p className="font-semibold text-gray-900">{doc.filename}</p>
                                                                            {doc.label && (
                                                                                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-primary-100 text-primary-700">{doc.label}</span>
                                                                            )}
                                                                        </div>
                                                                        {doc.description && (
                                                                            <p className="text-sm text-gray-600 mt-1">{doc.description}</p>
                                                                        )}
                                                                        <div className="grid grid-cols-2 gap-x-4 gap-y-1 mt-2 text-xs">
                                                                            <div>
                                                                                <span className="text-gray-500">Size:</span>
                                                                                <span className="ml-1 text-gray-700 font-medium">{formatFileSize(doc.file_size)}</span>
                                                                            </div>
                                                                            <div>
                                                                                <span className="text-gray-500">Type:</span>
                                                                                <span className="ml-1 text-gray-700 font-medium">{doc.mime_type || 'Unknown'}</span>
                                                                            </div>
                                                                            <div className="col-span-2">
                                                                                <span className="text-gray-500">Uploaded:</span>
                                                                                <span className="ml-1 text-gray-700 font-medium">
                                                                                    {new Date(doc.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' })} at {new Date(doc.created_at).toLocaleTimeString('en-US', {
                                                                                        hour: '2-digit', minute: '2-digit'
                                                                                    })}
                                                                                </span>
                                                                            </div>
                                                                            {doc.uploader?.display_name && (
                                                                                <div className="col-span-2">
                                                                                    <span className="text-gray-500">Uploaded by:</span>
                                                                                    <span className="ml-1 text-gray-700 font-medium">{doc.uploader.display_name}</span>
                                                                                </div>
                                                                            )}
                                                                            {doc.storage_path && (
                                                                                <div className="col-span-2">
                                                                                    <span className="text-gray-500">Path:</span>
                                                                                    <span className="ml-1 text-gray-600 font-mono text-[10px] truncate">{doc.storage_path}</span>
                                                                                </div>
                                                                            )}
                                                                        </div>
                                                                    </div>
                                                                </div>
                                                                <div className="flex flex-col gap-2 flex-shrink-0">
                                                                    {doc.download_url && (
                                                                        <>
                                                                            <Button
                                                                                variant="outline"
                                                                                size="sm"
                                                                                className="bg-white w-full"
                                                                                onClick={() => window.open(doc.download_url, '_blank', 'noopener,noreferrer')}
                                                                            >
                                                                                <svg className="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                                                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                                                                                </svg>
                                                                                View
                                                                            </Button>
                                                                            <Button
                                                                                variant="outline"
                                                                                size="sm"
                                                                                className="bg-white w-full"
                                                                                onClick={() => {
                                                                                    const link = document.createElement('a');
                                                                                    link.href = doc.download_url;
                                                                                    link.download = doc.filename;
                                                                                    document.body.appendChild(link);
                                                                                    link.click();
                                                                                    document.body.removeChild(link);
                                                                                }}
                                                                            >
                                                                                <svg className="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                                                                                </svg>
                                                                                Download
                                                                            </Button>
                                                                        </>
                                                                    )}
                                                                </div>
                                                            </div>
                                                        </div>
                                                    ))}
                                                </div>
                                            </Card>
                                        )}

                                        {/* Empty State */}
                                        {!hasDocuments && (
                                            <Card className="text-center py-12 border-dashed border-2 border-gray-200 bg-gray-50/50 shadow-none">
                                                <div className="w-16 h-16 bg-white rounded-full flex items-center justify-center mx-auto mb-4 shadow-sm border border-gray-100">
                                                    <svg className="w-8 h-8 text-text-secondary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                                                    </svg>
                                                </div>
                                                <h3 className="text-lg font-medium text-text-primary">No Documents Yet</h3>
                                                <p className="text-text-secondary">Upload files using the button above</p>
                                            </Card>
                                        )}
                                    </div>
                                );
                            })()}
                        </div>
                    </div>

                    {/* Right Column: Sidebar */}
                    <div className="space-y-6">

                        {/* Requester Card */}
                        <Card className="!p-6 border-gray-200 shadow-sm hover:shadow-md transition-shadow">
                            <h3 className="text-sm font-bold text-text-secondary uppercase tracking-widest mb-4">Requester</h3>
                            <div className="flex items-center gap-4">
                                <img
                                    src={request.creator.profile_picture_url || `https://ui-avatars.com/api/?name=${encodeURIComponent(request.creator.display_name || 'User')}&background=random`}
                                    alt={request.creator.display_name || 'User'}
                                    className="w-14 h-14 rounded-full border-2 border-white shadow-sm object-cover"
                                />
                                <div>
                                    <div className="font-bold text-text-primary text-lg">{request.creator.display_name}</div>
                                    <div className="text-sm text-text-secondary">{request.creator.job_title || 'No Job Title'}</div>
                                    <div className="text-xs text-primary-600 mt-1">{request.creator.email}</div>
                                </div>
                            </div>
                            {(() => {
                                const dept = request.metadata?.department || (request.creator as any)?.department?.name;
                                const bu = request.metadata?.unit || request.metadata?.businessUnit || request.metadata?.business_unit_name || (request.creator as any)?.business_unit?.name;
                                if (!dept && !bu) return null;
                                return (
                                    <div className="mt-4 grid grid-cols-2 gap-3">
                                        <div>
                                            <div className="text-xs text-gray-500 uppercase tracking-wide font-medium">Business Unit</div>
                                            <div className="text-sm font-medium text-gray-900 mt-0.5">{bu || '—'}</div>
                                        </div>
                                        <div>
                                            <div className="text-xs text-gray-500 uppercase tracking-wide font-medium">Department</div>
                                            <div className="text-sm font-medium text-gray-900 mt-0.5">{dept || '—'}</div>
                                        </div>
                                    </div>
                                );
                            })()}
                            {request.metadata?.onBehalfOf?.name && (
                                <div className="mt-4 rounded-lg bg-primary-50 border border-primary-200 px-3 py-2 text-sm text-primary-800">
                                    Filed on behalf of <strong>{request.metadata.onBehalfOf.name}</strong>
                                    {request.metadata.onBehalfOf.positionTitle ? ` (${request.metadata.onBehalfOf.positionTitle})` : ''}
                                </div>
                            )}
                        </Card>

                        {/* Current Step Card */}
                        <Card className="!p-6 border-primary-100 bg-gradient-to-br from-white to-primary-50/50 shadow-sm relative overflow-hidden">
                            <div className="absolute top-0 right-0 p-4 opacity-10">
                                <svg className="w-24 h-24" fill="currentColor" viewBox="0 0 24 24">
                                    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" />
                                </svg>
                            </div>

                            <h3 className="text-sm font-bold text-primary-500 uppercase tracking-widest mb-2">Current Step</h3>
                            <div className="text-2xl font-bold text-text-primary mb-1">
                                {request.request_steps?.find((s) => s.step_index + 1 === request.current_step)?.approver_role || (request.current_step > request.total_steps ? 'Completed' : 'Pending')}
                            </div>
                            {request.current_approver ? (
                                <div className="flex items-center gap-2 mt-4 p-3 bg-white/60 rounded-lg backdrop-blur-sm border border-white/50">
                                    <div className="w-8 h-8 rounded-full bg-primary-100 flex items-center justify-center text-primary-700 font-bold text-xs">
                                        {request.current_approver.display_name?.charAt(0) || '?'}
                                    </div>
                                    <div>
                                        <div className="text-xs text-text-secondary">Waiting for</div>
                                        <div className="text-sm font-semibold text-text-primary">{request.current_approver.display_name}</div>
                                    </div>
                                </div>
                            ) : (
                                <div className="mt-4 text-sm text-text-secondary">No active approver pending.</div>
                            )}
                        </Card>

                        {/* Meta Info */}
                        <Card className="!p-0 border-gray-200 overflow-hidden text-sm">
                            <div className="p-4 border-b border-gray-100 flex justify-between items-center bg-gray-50/50">
                                <span className="text-text-secondary">Status</span>
                                <span className="font-medium text-text-primary">{statusInfo.label}</span>
                            </div>
                            <div className="p-4 border-b border-gray-100 flex justify-between items-center">
                                <span className="text-text-secondary">Created</span>
                                <span className="font-medium text-text-primary">{new Date(request.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' })}</span>
                            </div>
                            <div className="p-4 flex justify-between items-center">
                                <span className="text-text-secondary">Last Updated</span>
                                <span className="font-medium text-text-primary">{new Date(request.updated_at).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' })}</span>
                            </div>
                        </Card>

                    </div>
                </div>

                {/* Reject Confirmation */}
                <ConfirmDialog
                    isOpen={showRejectConfirm}
                    title="Reject this request?"
                    message={
                        <span>
                            Are you sure you want to reject &ldquo;<span className="font-medium text-gray-900">{request?.title}</span>&rdquo;?
                            The requester will be notified and the workflow will not advance.
                        </span>
                    }
                    confirmLabel="Reject"
                    cancelLabel="Go back"
                    busy={reviewProcessing}
                    variant="danger"
                    onCancel={() => setShowRejectConfirm(false)}
                    onConfirm={async () => {
                        setShowRejectConfirm(false);
                        await handleApprovalAction('reject');
                    }}
                />

                {/* Approve Confirmation */}
                <ConfirmDialog
                    isOpen={showApproveConfirm}
                    title="Approve this request?"
                    message={
                        <span>
                            Approve &ldquo;<span className="font-medium text-gray-900">{request?.title}</span>&rdquo;?
                            Your signature will be applied and the request will move to the next approver
                            (or be finalised if you are the last approver).
                        </span>
                    }
                    confirmLabel="Approve"
                    cancelLabel="Go back"
                    busy={reviewProcessing}
                    onCancel={() => setShowApproveConfirm(false)}
                    onConfirm={async () => {
                        setShowApproveConfirm(false);
                        await submitDecision('approve');
                    }}
                />

                {/* Screening: Return-to-requestor comment modal */}
                {showScreenReturn && (
                    <div
                        className="fixed inset-0 z-[120] flex items-center justify-center bg-black/40 p-4"
                        onClick={() => { if (!screenBusy) setShowScreenReturn(false); }}
                    >
                        <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
                            <h3 className="text-lg font-semibold text-gray-900 mb-1">Return to requestor</h3>
                            <p className="text-sm text-gray-500 mb-4">
                                &ldquo;<span className="font-medium text-gray-900">{request?.title}</span>&rdquo; will go back to the
                                requestor&apos;s Drafts with your comment, and they&apos;ll be notified.
                            </p>
                            <textarea
                                value={screenReturnComment}
                                onChange={(e) => setScreenReturnComment(e.target.value)}
                                placeholder="Explain what needs to change before this can go forward…"
                                rows={4}
                                className="w-full px-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-primary-500 focus:border-transparent resize-none"
                                autoFocus
                            />
                            {screenError && <p className="text-sm text-red-600 font-medium mt-2">{screenError}</p>}
                            <div className="flex justify-end gap-3 mt-4">
                                <Button
                                    variant="outline"
                                    onClick={() => { setShowScreenReturn(false); setScreenReturnComment(''); }}
                                    disabled={screenBusy}
                                >
                                    Cancel
                                </Button>
                                <Button
                                    variant="danger"
                                    onClick={submitScreenReturn}
                                    disabled={screenBusy || !screenReturnComment.trim()}
                                >
                                    {screenBusy ? 'Returning…' : 'Return with comment'}
                                </Button>
                            </div>
                        </div>
                    </div>
                )}

                {/* Delete Confirmation Modal */}
                {showDeleteConfirm && (
                    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
                        <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl">
                            <div className="flex items-center gap-4 mb-4">
                                <div className="w-12 h-12 rounded-full bg-danger-100 flex items-center justify-center flex-shrink-0">
                                    <svg className="w-6 h-6 text-danger-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                    </svg>
                                </div>
                                <div>
                                    <h3 className="text-lg font-bold text-text-primary">Delete Request</h3>
                                    <p className="text-sm text-text-secondary">This action cannot be undone</p>
                                </div>
                            </div>
                            <p className="text-text-secondary mb-6">
                                Are you sure you want to delete &ldquo;<span className="font-medium text-text-primary">{request.title}</span>&rdquo;?
                                All associated data including documents and approval steps will be permanently removed.
                            </p>
                            <div className="flex gap-3 justify-end">
                                <Button
                                    variant="outline"
                                    onClick={() => setShowDeleteConfirm(false)}
                                    disabled={deleting}
                                >
                                    Cancel
                                </Button>
                                <Button
                                    variant="danger"
                                    onClick={handleDelete}
                                    disabled={deleting}
                                    isLoading={deleting}
                                >
                                    {deleting ? 'Deleting...' : 'Delete Request'}
                                </Button>
                            </div>
                        </div>
                    </div>
                )}

                {/* Cancel Request Modal — requires a reason */}
                {showCancelModal && (
                    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[120] p-4">
                        <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl">
                            <div className="flex items-center gap-4 mb-4">
                                <div className="w-12 h-12 rounded-full bg-danger-100 flex items-center justify-center flex-shrink-0">
                                    <svg className="w-6 h-6 text-danger-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                                    </svg>
                                </div>
                                <div>
                                    <h3 className="text-lg font-bold text-text-primary">Cancel Request</h3>
                                    <p className="text-sm text-text-secondary">The record is kept; the request is marked cancelled</p>
                                </div>
                            </div>
                            <p className="text-text-secondary mb-3 text-sm">
                                Cancelling &ldquo;<span className="font-medium text-text-primary">{request.title}</span>&rdquo;
                                {(actualStatus || request.status) === 'approved' ? ' (currently approved)' : ''}. The requester and
                                approvers will be notified. Please explain why this request is being cancelled.
                            </p>
                            <label className="block text-sm font-medium text-gray-700 mb-1">
                                Reason for cancellation <span className="text-danger-600">*</span>
                            </label>
                            <textarea
                                value={cancelReason}
                                onChange={(e) => setCancelReason(e.target.value)}
                                placeholder="e.g. Project shelved / duplicate request / no longer required…"
                                className="w-full px-4 py-2.5 rounded-xl border border-gray-300 bg-white text-gray-900 focus:outline-none focus:ring-2 focus:ring-danger-500 focus:border-transparent min-h-[100px] mb-5"
                                autoFocus
                            />
                            <div className="flex gap-3 justify-end">
                                <Button
                                    variant="outline"
                                    onClick={() => { setShowCancelModal(false); setCancelReason(''); }}
                                    disabled={cancelling}
                                >
                                    Keep Request
                                </Button>
                                <Button
                                    variant="danger"
                                    onClick={handleCancel}
                                    disabled={cancelling || !cancelReason.trim()}
                                    isLoading={cancelling}
                                >
                                    {cancelling ? 'Cancelling…' : 'Cancel Request'}
                                </Button>
                            </div>
                        </div>
                    </div>
                )}

                {/* Review/Approval Modal */}
                {showReviewModal && (
                    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
                        <div className="bg-white rounded-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto shadow-2xl">
                            <div className="border-b border-gray-100 bg-gray-50/50 px-6 py-4 rounded-t-2xl flex items-center justify-between">
                                <div>
                                    <h2 className="text-lg font-bold text-gray-900">Review Request</h2>
                                    <p className="text-xs text-gray-500 mt-0.5">#{request.id.slice(0, 8)}</p>
                                </div>
                                <button
                                    onClick={() => {
                                        setShowReviewModal(false);
                                        setReviewComment('');
                                        setReviewError(null);
                                    }}
                                    className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-full transition-colors"
                                >
                                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" />
                                    </svg>
                                </button>
                            </div>

                            <div className="p-6 space-y-6">
                                <div className="space-y-1">
                                    <h3 className="text-xl font-semibold text-gray-900">{request.title}</h3>
                                    <p className="text-gray-600 leading-relaxed text-sm">
                                        {request.description || 'No description provided.'}
                                    </p>
                                </div>

                                {/* Request Summary */}
                                <div className="grid grid-cols-2 gap-4 bg-gray-50 p-4 rounded-xl border border-gray-100">
                                    <div>
                                        <div className="text-xs text-gray-500 uppercase tracking-wide font-medium">Submitted</div>
                                        <div className="text-sm font-medium text-gray-900 mt-0.5">
                                            {new Date(request.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' })}
                                        </div>
                                    </div>
                                    {request.metadata?.amount && (
                                        <div>
                                            <div className="text-xs text-gray-500 uppercase tracking-wide font-medium">Amount</div>
                                            <div className="text-sm font-medium text-gray-900 mt-0.5">
                                                {request.metadata?.currency || 'USD'} {parseAmount(request.metadata.amount).toLocaleString()}
                                            </div>
                                        </div>
                                    )}
                                    <div>
                                        <div className="text-xs text-gray-500 uppercase tracking-wide font-medium">Requester</div>
                                        <div className="text-sm font-medium text-gray-900 mt-0.5">
                                            {request.creator?.display_name || 'Unknown'}
                                        </div>
                                    </div>
                                    <div>
                                        <div className="text-xs text-gray-500 uppercase tracking-wide font-medium">Business Unit</div>
                                        <div className="text-sm font-medium text-gray-900 mt-0.5">
                                            {request.metadata?.unit || request.metadata?.businessUnit || request.metadata?.business_unit_name || (request.creator as any)?.business_unit?.name || 'N/A'}
                                        </div>
                                    </div>
                                    <div>
                                        <div className="text-xs text-gray-500 uppercase tracking-wide font-medium">Department</div>
                                        <div className="text-sm font-medium text-gray-900 mt-0.5">
                                            {request.metadata?.department || (request.creator as any)?.department?.name || 'N/A'}
                                        </div>
                                    </div>
                                </div>

                                {/* HR Director: Cost Allocation. Required for travel auths and
                                    hotel bookings. When a grand total exists, allocations must
                                    sum to it; for pure complimentary bookings without a precomputed
                                    total, the HRD allocates the comp value across units (any
                                    non-zero allocation passes validation). */}
                                {isHrdApprovingTravelAuth && (
                                    <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
                                        <div className="flex items-center justify-between mb-2">
                                            <div className="text-xs text-amber-700 uppercase tracking-wide font-medium">
                                                Cost Allocation (Required)
                                            </div>
                                            {hasGrandTotalToBalance && (
                                                <div className="text-xs text-amber-700">
                                                    Grand Total: <span className="font-semibold">{travelAuthGrandTotal.toFixed(2)}</span>
                                                </div>
                                            )}
                                        </div>
                                        <p className="text-xs text-amber-700 mb-3">
                                            {hasGrandTotalToBalance
                                                ? 'As Chief Human Capital Officer, please allocate the cost across the units below. Totals must match the grand total before you can approve.'
                                                : 'As Chief Human Capital Officer, please allocate the complimentary value across the units below before you can approve.'}
                                        </p>

                                        {/* Hotel bookings: HRD also picks the category (Marketing,
                                            Administration, etc.). This used to be set by the
                                            requester on the form — now it's the HRD's call. */}
                                        {isHotelBooking && (
                                            <div className="mb-3 bg-white rounded-lg border border-amber-200 p-2.5">
                                                <label className="block text-xs font-medium text-gray-700 mb-1 uppercase">Allocation Category</label>
                                                <select
                                                    value={hrdAllocationCategory}
                                                    onChange={e => setHrdAllocationCategory(e.target.value)}
                                                    disabled={reviewProcessing}
                                                    className="w-full text-sm px-2 py-1.5 border border-gray-200 rounded focus:ring-1 focus:ring-amber-500 focus:border-amber-500 outline-none bg-white"
                                                >
                                                    <option value="">Select category…</option>
                                                    <option value="marketing_domestic">Marketing – Domestic</option>
                                                    <option value="marketing_international">Marketing – International</option>
                                                    <option value="administration">Administration</option>
                                                    <option value="promotions">Promotions</option>
                                                    <option value="personnel">Personnel</option>
                                                </select>
                                            </div>
                                        )}

                                        <div className="grid grid-cols-2 gap-2">
                                            {relevantTravelUnits.map(unit => (
                                                <label key={unit} className="flex items-center gap-2 bg-white rounded-lg border border-amber-200 px-2 py-1.5">
                                                    <span className="text-xs font-medium text-gray-700 w-12 uppercase">{unit}</span>
                                                    <input
                                                        type="number"
                                                        step="0.01"
                                                        min="0"
                                                        value={hrdCostAllocation[unit]}
                                                        onChange={e => setHrdCostAllocation(prev => ({ ...prev, [unit]: e.target.value }))}
                                                        disabled={reviewProcessing}
                                                        className="flex-1 min-w-0 text-sm px-2 py-1 border border-gray-200 rounded focus:ring-1 focus:ring-amber-500 focus:border-amber-500 outline-none"
                                                        placeholder="0.00"
                                                    />
                                                </label>
                                            ))}
                                        </div>
                                        <p className="text-xs text-amber-700 mt-2">
                                            Only the business units involved in the itinerary / booking are shown. CORP is always available for shared / overhead costs.
                                        </p>
                                        <div className={`mt-3 text-xs font-medium flex items-center justify-between ${hrdAllocationValid ? 'text-green-700' : 'text-red-700'}`}>
                                            <span>Allocated: {hrdAllocationSum.toFixed(2)}</span>
                                            <span>
                                                {hrdAllocationValid
                                                    ? (hasGrandTotalToBalance ? 'Allocation matches grand total' : 'Allocation recorded')
                                                    : (hasGrandTotalToBalance
                                                        ? `Remaining: ${(travelAuthGrandTotal - hrdAllocationSum).toFixed(2)}`
                                                        : 'At least one allocation must be greater than zero')}
                                            </span>
                                        </div>
                                    </div>
                                )}

                                <div className="bg-primary-50 border border-primary-100 rounded-xl p-4">
                                    <div className="text-xs text-primary-600 uppercase tracking-wide font-medium mb-2">Your Signature</div>
                                    <SignatureSelector
                                        savedSignatureUrl={userSignatureUrl}
                                        userDisplayName={(session?.user as any)?.name || request?.creator?.display_name}
                                        value={signatureSelection}
                                        onChange={setSignatureSelection}
                                        disabled={reviewProcessing}
                                    />
                                    <p className="text-xs text-primary-600 mt-2">
                                        Your signature will be attached to this approval.
                                    </p>
                                </div>

                                {reviewError && (
                                    <div className="p-3 bg-red-50 border border-red-200 rounded-lg flex items-start gap-2">
                                        <svg className="w-4 h-4 text-red-500 mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                                        </svg>
                                        <p className="text-sm text-red-600 font-medium">{reviewError}</p>
                                    </div>
                                )}

                                <div>
                                    <label className="block text-sm font-medium text-gray-700 mb-2">
                                        Review Comment <span className="text-gray-400 font-normal">(Required for rejection)</span>
                                    </label>
                                    <textarea
                                        value={reviewComment}
                                        onChange={(e) => setReviewComment(e.target.value)}
                                        placeholder="Enter your feedback or reasoning here..."
                                        className="w-full px-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-primary-500 focus:border-transparent resize-none transition-shadow"
                                        rows={4}
                                    />
                                </div>
                            </div>

                            <div className="p-6 bg-gray-50/50 border-t border-gray-100 flex justify-end gap-3 rounded-b-2xl">
                                <Button
                                    variant="outline"
                                    onClick={() => {
                                        setShowReviewModal(false);
                                        setReviewComment('');
                                        setReviewError(null);
                                    }}
                                    disabled={reviewProcessing}
                                    className="bg-white hover:bg-gray-50"
                                >
                                    Cancel
                                </Button>
                                <Button
                                    variant="danger"
                                    onClick={() => {
                                        if (!reviewComment.trim()) {
                                            setReviewError('Please provide a reason for rejection');
                                            return;
                                        }
                                        setReviewError(null);
                                        setShowRejectConfirm(true);
                                    }}
                                    disabled={reviewProcessing}
                                    className="min-w-[5rem]"
                                >
                                    {reviewProcessing ? '...' : 'Reject'}
                                </Button>
                                <Button
                                    variant="primary"
                                    onClick={() => handleApprovalAction('approve')}
                                    disabled={reviewProcessing || (isHrdApprovingTravelAuth && !hrdAllocationValid)}
                                    className="min-w-[6rem]"
                                >
                                    {reviewProcessing ? 'Processing...' : 'Approve'}
                                </Button>
                            </div>
                        </div>
                    </div>
                )}

                {/* Document Upload Modal */}
                {showUploadModal && uploadFile && (
                    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
                        <div className="bg-white rounded-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto shadow-2xl">
                            <div className="border-b border-gray-100 bg-gray-50/50 px-6 py-4 rounded-t-2xl flex items-center justify-between">
                                <div>
                                    <h2 className="text-lg font-bold text-gray-900">Upload Document</h2>
                                    <p className="text-xs text-gray-500 mt-0.5">Add details about your document</p>
                                </div>
                                <button
                                    onClick={() => {
                                        setShowUploadModal(false);
                                        setUploadFile(null);
                                        setUploadMetadata({
                                            description: '',
                                            supplierName: '',
                                            isSelectedSupplier: false,
                                            selectionReason: '',
                                        });
                                    }}
                                    className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-full transition-colors"
                                >
                                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" />
                                    </svg>
                                </button>
                            </div>

                            <div className="p-6 space-y-5">
                                {/* File Info */}
                                <div className="flex items-center gap-3 p-4 bg-gray-50 rounded-xl border border-gray-200">
                                    <div className="w-12 h-12 bg-primary-100 rounded-lg flex items-center justify-center flex-shrink-0">
                                        <svg className="w-6 h-6 text-primary-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                                        </svg>
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <p className="font-medium text-gray-900 truncate">{uploadFile.name}</p>
                                        <p className="text-xs text-gray-500">{(uploadFile.size / 1024).toFixed(1)} KB</p>
                                    </div>
                                </div>

                                {/* Document Type */}
                                <div>
                                    <label className="block text-sm font-medium text-gray-700 mb-2">Document Type</label>
                                    <div className="flex gap-3">
                                        <button
                                            type="button"
                                            onClick={() => setUploadDocumentType('quotation')}
                                            className={`flex-1 p-3 rounded-xl border-2 transition-all ${
                                                uploadDocumentType === 'quotation'
                                                    ? 'border-emerald-500 bg-emerald-50 text-emerald-700'
                                                    : 'border-gray-200 hover:border-gray-300 text-gray-600'
                                            }`}
                                        >
                                            <svg className="w-5 h-5 mx-auto mb-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                                            </svg>
                                            <span className="text-sm font-medium">Quotation</span>
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => setUploadDocumentType('supporting')}
                                            className={`flex-1 p-3 rounded-xl border-2 transition-all ${
                                                uploadDocumentType === 'supporting'
                                                    ? 'border-[#9A7545] bg-[#F3EADC] text-[#5E4426]'
                                                    : 'border-gray-200 hover:border-gray-300 text-gray-600'
                                            }`}
                                        >
                                            <svg className="w-5 h-5 mx-auto mb-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                                            </svg>
                                            <span className="text-sm font-medium">Supporting Doc</span>
                                        </button>
                                    </div>
                                </div>

                                {/* Description */}
                                <div>
                                    <label className="block text-sm font-medium text-gray-700 mb-2">Description</label>
                                    <input
                                        type="text"
                                        className="w-full px-4 py-2.5 rounded-xl border border-gray-300 focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-all"
                                        placeholder="Brief description of this document..."
                                        value={uploadMetadata.description}
                                        onChange={(e) => setUploadMetadata(prev => ({ ...prev, description: e.target.value }))}
                                    />
                                </div>

                                {/* Quotation-specific fields */}
                                {uploadDocumentType === 'quotation' && (
                                    <>
                                        <div>
                                            <label className="block text-sm font-medium text-gray-700 mb-2">Supplier Name</label>
                                            <input
                                                type="text"
                                                className="w-full px-4 py-2.5 rounded-xl border border-gray-300 focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-all"
                                                placeholder="Name of the supplier..."
                                                value={uploadMetadata.supplierName}
                                                onChange={(e) => setUploadMetadata(prev => ({ ...prev, supplierName: e.target.value }))}
                                            />
                                        </div>

                                        <div className="flex items-center gap-3 p-4 bg-emerald-50 rounded-xl border border-emerald-200">
                                            <input
                                                type="checkbox"
                                                id="isSelectedSupplier"
                                                checked={uploadMetadata.isSelectedSupplier}
                                                onChange={(e) => setUploadMetadata(prev => ({ ...prev, isSelectedSupplier: e.target.checked }))}
                                                className="w-5 h-5 rounded border-emerald-300 text-emerald-600 focus:ring-emerald-500"
                                            />
                                            <label htmlFor="isSelectedSupplier" className="flex-1">
                                                <span className="font-medium text-emerald-800">This is the selected supplier</span>
                                                <p className="text-xs text-emerald-600 mt-0.5">Mark if this quotation is from the chosen supplier</p>
                                            </label>
                                        </div>

                                        {uploadMetadata.isSelectedSupplier && (
                                            <div>
                                                <label className="block text-sm font-medium text-gray-700 mb-2">Selection Reason</label>
                                                <textarea
                                                    className="w-full px-4 py-2.5 rounded-xl border border-gray-300 focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-all resize-none"
                                                    rows={3}
                                                    placeholder="Why was this supplier selected?"
                                                    value={uploadMetadata.selectionReason}
                                                    onChange={(e) => setUploadMetadata(prev => ({ ...prev, selectionReason: e.target.value }))}
                                                />
                                            </div>
                                        )}
                                    </>
                                )}
                            </div>

                            <div className="border-t border-gray-100 bg-gray-50/50 px-6 py-4 rounded-b-2xl flex justify-end gap-3">
                                <Button
                                    variant="secondary"
                                    onClick={() => {
                                        setShowUploadModal(false);
                                        setUploadFile(null);
                                        setUploadMetadata({
                                            description: '',
                                            supplierName: '',
                                            isSelectedSupplier: false,
                                            selectionReason: '',
                                        });
                                    }}
                                    disabled={uploadingDocument || uploadingApproverDocument}
                                >
                                    Cancel
                                </Button>
                                <Button
                                    variant="primary"
                                    onClick={handleUploadWithMetadata}
                                    disabled={uploadingDocument || uploadingApproverDocument}
                                    isLoading={uploadingDocument || uploadingApproverDocument}
                                >
                                    {(uploadingDocument || uploadingApproverDocument) ? 'Uploading...' : 'Upload Document'}
                                </Button>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </AppLayout>
    );
}
